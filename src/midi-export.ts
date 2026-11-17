import type { Midi } from "@tonejs/midi";
import type { TrackAssignment } from "./types";
import { createCompositionMidi } from "./composition";
import { scaleTempo } from "./tempo";
import { trimEmptySpace } from "./trim-midi";

export interface MidiExportOptions {
  includeUnselected?: boolean;
  trimEmptySpace?: boolean;
}

export function createMidiExport(source: Midi, sourceName: string, assignments: Record<number, TrackAssignment>, tempoRate = 1, options: MidiExportOptions = {}) {
  const stem = sourceName.replace(/\.(midi?|smf)$/i, "") || "composition";
  const midi = createCompositionMidi(source, assignments, false, options.includeUnselected);
  if (options.trimEmptySpace) trimEmptySpace(midi);
  scaleTempo(midi, tempoRate);
  return { filename: `${stem}-ffxiv.mid`, bytes: midi.toArray() };
}
