import { Midi } from "@tonejs/midi";
import type { TrackAssignment } from "./types";
import { FFXIV_INSTRUMENTS } from "./ffxiv";
import { noteRange, pitchMapper } from "./auto-transpose";
import { stripExpression } from "./strip-expression";

export function isTrackSelected(assignment?: Partial<TrackAssignment>): boolean {
  return assignment?.selected !== false;
}

export function setSelectedTranspose(assignments: Record<number, TrackAssignment>, enabled: boolean, indexes?: Set<number>): void {
  for (const [index, assignment] of Object.entries(assignments)) {
    if (isTrackSelected(assignment) && (!indexes || indexes.has(Number(index)))) assignment.autoTranspose = enabled;
  }
}

export function createCompositionMidi(source: Midi, assignments: Record<number, TrackAssignment>, autoTranspose = false, includeUnselected = false): Midi {
  const midi = new Midi();
  midi.fromJSON(source.toJSON());
  midi.tracks = midi.tracks.filter((track, index) => {
    const assignment = assignments[index];
    if (!assignment || (!includeUnselected && !isTrackSelected(assignment))) return false;
    track.name = FFXIV_INSTRUMENTS.find(i => i.program === assignment.preset)?.name ?? track.name;
    track.instrument.number = assignment.preset;
    stripExpression(track);
    const pitch = pitchMapper(noteRange(track.notes), assignment, autoTranspose);
    for (const note of track.notes) {
      const adapted = pitch(note.midi);
      if (adapted < 0 || adapted > 127) throw new Error(`Track ${track.name} has notes outside the MIDI range.`);
      note.midi = adapted;
      note.velocity = 100 / 127;
      note.noteOffVelocity = 0;
    }
    return true;
  });
  return midi;
}
