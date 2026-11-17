import { Sequencer, WorkletSynthesizer } from "spessasynth_lib";
import { trackChannel } from "./routing";
import type { TrackAssignment } from "../types";
import { isTrackSelected } from "../composition";
import workletUrl from "/spessasynth_processor.min.js?url";

const SOUNDFONT_FILENAME = "FFXIV-Standard.sf2";
const soundFontUrl = workletUrl.slice(0, workletUrl.lastIndexOf("/") + 1) + SOUNDFONT_FILENAME;

export class SpessaPlayer {
  private context: AudioContext | null = null;
  private synth: WorkletSynthesizer | null = null;
  private output: GainNode | null = null;
  private sequencer: Sequencer | null = null;
  private soundFontLoaded = false;
  private disposed = false;
  private cancellation = new AbortController();
  private channels = new Map<number, number>();
  private cancelLoad: (() => void) | null = null;
  private rate = 1;
  private volume = 1;
  onEnded: (() => void) | null = null;

  async loadSoundFont(): Promise<void> {
    await this.ensureSynth();
    this.assertActive();
    if (this.soundFontLoaded) return;

    const response = await fetch(soundFontUrl, {
      signal: this.cancellation.signal,
    });
    if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
      throw new Error(`SoundFont unavailable. Place ${SOUNDFONT_FILENAME} in the public folder before building or running locally.`);
    }
    const bytes = await response.arrayBuffer();
    this.assertActive();
    await this.wait(this.synth!.soundBankManager.addSoundBank(bytes, SOUNDFONT_FILENAME));
    this.assertActive();
    this.soundFontLoaded = true;
  }

  get currentTime(): number { return this.sequencer?.currentTime ?? 0; }
  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.rate = rate;
    if (this.sequencer) this.sequencer.playbackRate = rate;
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.output && this.context) this.output.gain.setTargetAtTime(this.volume, this.context.currentTime, .01);
  }

  seek(time: number): void {
    if (!this.sequencer || this.disposed || !Number.isFinite(time)) return;
    this.synth?.stopAll(true);
    this.sequencer.currentTime = Math.max(0, Math.min(time, this.sequencer.duration));
  }

  async play(bytes: Uint8Array, name: string, assignments: Record<number, TrackAssignment>, startTime = 0, paused = false): Promise<void> {
    await this.ensureSynth();
    this.assertActive();
    this.channels.clear();
    Object.keys(assignments).forEach((key, position) => this.channels.set(Number(key), trackChannel(position)));
    const seq = this.sequencer!;
    seq.pause();
    this.synth!.stopAll(true);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        seq.eventHandler.removeEvent("songChange", "load");
        seq.eventHandler.removeEvent("midiError", "load");
        this.cancelLoad = null;
      };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const timeout = setTimeout(() => fail(new Error("MIDI loading timed out.")), 15000);
      this.cancelLoad = () => fail(new Error("Playback session replaced."));
      seq.eventHandler.addEvent("songChange", "load", () => { cleanup(); resolve(); });
      seq.eventHandler.addEvent("midiError", "load", fail);
      seq.loadNewSongList([{ binary: toArrayBuffer(bytes), fileName: name }]);
    });
    this.assertActive();
    this.updateAssignments(assignments);
    seq.playbackRate = this.rate;
    seq.currentTime = startTime;
    if (!paused) seq.play();
  }

  updateAssignments(assignments: Record<number, TrackAssignment>): void {
    if (!this.synth || this.disposed) return;
    for (const [index, channel] of this.channels) {
      const assignment = assignments[index];
      const part = this.synth.midiChannels[channel];
      if (!assignment || !part) continue;
      part.setSystemParameter("presetLock", false);
      part.setDrums(false);
      this.synth.controllerChange(channel, 0, 0);
      this.synth.controllerChange(channel, 32, 0);
      this.synth.programChange(channel, assignment.preset);
      part.setSystemParameter("presetLock", true);
      part.setSystemParameter("isMuted", !isTrackSelected(assignment));
    }
  }

  remapTracks(indexMap: Readonly<Record<number, number>>): void {
    const remapped = new Map<number, number>();
    for (const [oldIndex, channel] of this.channels) {
      const newIndex = indexMap[oldIndex];
      if (newIndex !== undefined) remapped.set(newIndex, channel);
    }
    this.channels = remapped;
  }

  pause(): void { this.sequencer?.pause(); }
  async resume(): Promise<void> {
    await this.context?.resume();
    this.assertActive();
    this.sequencer?.play();
  }

  stop(): void {
    this.sequencer?.pause();
    if (this.sequencer) this.sequencer.currentTime = 0;
    this.synth?.stopAll(true);
  }

  dispose(): void {
    this.disposed = true;
    this.cancellation.abort();
    this.cancelLoad?.();
    this.onEnded = null;
    this.synth?.disconnect();
    this.output?.disconnect();
    this.synth?.destroy();
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
    this.synth = null;
    this.output = null;
    this.sequencer = null;
    this.channels.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Playback session replaced.");
  }

  private wait<T>(operation: Promise<T>): Promise<T> {
    this.assertActive();
    return new Promise<T>((resolve, reject) => {
      const signal = this.cancellation.signal;
      const abort = () => reject(new Error("Playback session replaced."));
      signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async ensureSynth(): Promise<void> {
    this.assertActive();
    if (this.synth && this.sequencer) return;
    const context = new AudioContext();
    this.context = context;
    try {
      await this.wait(context.resume());
      this.assertActive();
      await this.wait(context.audioWorklet.addModule(workletUrl));
      this.assertActive();
      const synth = new WorkletSynthesizer(context);
      this.synth = synth;
      const output = context.createGain();
      output.gain.value = this.volume;
      output.connect(context.destination);
      this.output = output;
      synth.connect(output);
      await this.wait(synth.isReady);
      this.assertActive();
      this.sequencer = new Sequencer(synth, { skipToFirstNoteOn: false, initialPlaybackRate: 1 });
      this.sequencer.eventHandler.addEvent("songEnded", "status", () => this.onEnded?.());
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
