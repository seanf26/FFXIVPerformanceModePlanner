import { Midi, type Track } from "@tonejs/midi";
import { parseMidi as parseEvents, writeMidi } from "midi-file";
import type { TrackSummary } from "./types";
import { noteRange } from "./auto-transpose";

export type ParsedMidi = {
  midi: Midi;
  summaries: TrackSummary[];
};

export function parseMidi(bytes: Uint8Array): ParsedMidi {
  const midi = new Midi(bytes);
  const raw = parseEvents(bytes);
  if (raw.header.format === 1) {
    midi.tracks = raw.tracks.flatMap((events) => {
      const part = new Midi(new Uint8Array(writeMidi({
        header: { ...raw.header, format: 0, numTracks: 1 }, tracks: [events],
      })));
      part.header.fromJSON(midi.header.toJSON());
      const instrumentName = events.find(event => event.type === "instrumentName");
      for (const track of part.tracks) {
        track.name = cleanName(track.name) ||
          (instrumentName?.type === "instrumentName" ? cleanName(instrumentName.text) : "");
      }
      part.tracks = filterNotationAuxiliaries(part.tracks);
      const sounding = part.tracks.filter((track) => track.notes.length);
      const strings = sounding.filter((track) => track.channel !== 9 &&
        track.instrument.number >= 40 && track.instrument.number <= 43);
      if (strings.length !== 1 || sounding.some((track) => track.channel === 9 ||
        track.instrument.number < 40 || track.instrument.number > 45)) return part.tracks;
      const parent = strings[0];
      const articulations = sounding.filter((track) =>
        track.instrument.number === 44 || track.instrument.number === 45);
      if (!articulations.length) return part.tracks;
      const notes = sounding.flatMap((track) => track.notes.map((note) => ({ note, track })))
        .sort((a, b) => a.note.ticks - b.note.ticks);
      const ends = new Map<typeof parent, number>();
      for (const { note, track } of notes) {
        if ([...ends].some(([other, end]) => other !== track && end > note.ticks)) return part.tracks;
        ends.set(track, Math.max(ends.get(track) ?? 0, note.ticks + note.durationTicks));
      }
      parent.notes = notes.map(({ note }) => note);
      for (const track of articulations) {
        for (const changes of Object.values(track.controlChanges)) {
          for (const cc of changes ?? []) parent.addCC({ number: cc.number, ticks: cc.ticks, value: cc.value });
        }
        parent.pitchBends.push(...track.pitchBends);
      }
      parent.pitchBends.sort((a, b) => a.ticks - b.ticks);
      return part.tracks.filter((track) => !articulations.includes(track));
    });
  }
  return { midi, summaries: summarizeMidi(midi) };
}

export function summarizeMidi(midi: Midi): TrackSummary[] {
  const summaries: TrackSummary[] = [];
  midi.tracks.forEach((track, index) => {
    if (!track.notes.length) return;
    summaries.push({
      index,
      name: cleanName(track.name) || (track.channel === 9 ? "Drumset" : instrumentLabel(track)),
      program: track.instrument.number,
      noteCount: track.notes.length,
      ...noteRange(track.notes),
    });
  });
  return summaries;
}

function cleanName(name: string): string {
  return name.replaceAll("\u0000", "").trim();
}

function instrumentLabel(track: Track): string {
  return track.instrument.name.replace(/\b\w/g, letter => letter.toUpperCase()) || "Piano";
}

export function filterNotationAuxiliaries(tracks: Track[]): Track[] {
  const sounding = tracks.filter(track => track.notes.length);
  const dominant = sounding.reduce<Track | null>((best, track) =>
    !best || track.notes.length > best.notes.length ? track : best, null);
  const hasSilentTechniqueChannel = tracks.some(track =>
    track.notes.length === 0 && (track.instrument.number === 44 || track.instrument.number === 45));
  if (!dominant || dominant.notes.length < 40 || !hasSilentTechniqueChannel) return tracks;
  return tracks.filter(track =>
    !track.notes.length || track === dominant ||
    track.notes.length > 16 || track.notes.length * 10 > dominant.notes.length);
}

