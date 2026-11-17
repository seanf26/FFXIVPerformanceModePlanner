import type { Midi } from "@tonejs/midi";

export const DEFAULT_BPM = 120;
export const MIN_BPM = 20;
export const MAX_BPM = 400;

export function originalBpm(midi?: Midi | null): number {
  return midi?.header.tempos[0]?.bpm ?? DEFAULT_BPM;
}

export function tempoRate(targetBpm: number, sourceBpm: number): number {
  return targetBpm / sourceBpm;
}

export function scaleTempo(midi: Midi, rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Tempo must be greater than zero.");
  if (!midi.header.tempos.length) midi.header.setTempo(DEFAULT_BPM * rate);
  else for (const tempo of midi.header.tempos) tempo.bpm *= rate;
  midi.header.update();
}
