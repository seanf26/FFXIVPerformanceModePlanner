import { FFXIV_MAX_NOTE, FFXIV_MIN_NOTE } from "./ffxiv";
import type { TrackAssignment } from "./types";

export function noteRange(notes: readonly { midi: number }[]) {
  let minNote = Infinity;
  let maxNote = -Infinity;
  for (const { midi } of notes) {
    minNote = Math.min(minNote, midi);
    maxNote = Math.max(maxNote, midi);
  }
  return { minNote, maxNote };
}

export function pitchMapper(
  range: { minNote: number; maxNote: number }, assignment?: Partial<TrackAssignment>, allTracks = false,
): (note: number) => number {
  const transpose = assignment?.transpose ?? 0;
  if (!allTracks && !assignment?.autoTranspose) return note => note + transpose;
  const fit = fitOctaves(range.minNote + transpose, range.maxNote + transpose);
  return fit === null ? note => adaptNote(note + transpose) : note => note + transpose + fit;
}

export function fitOctaves(minNote: number, maxNote: number): number | null {
  const minOctaves = Math.ceil((FFXIV_MIN_NOTE - minNote) / 12);
  const maxOctaves = Math.floor((FFXIV_MAX_NOTE - maxNote) / 12);
  if (minOctaves > maxOctaves) return null;
  return 12 * Math.max(minOctaves, Math.min(0, maxOctaves));
}

export function adaptNote(note: number): number {
  let key = note - 48;
  if (key < 0) key = (key + 1) % 12 + 11;
  else if (key > 36) key = (key - 1) % 12 + 25;
  return key + 48;
}
