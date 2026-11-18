import { Midi, type Track } from "@tonejs/midi";
import { noteRange, pitchMapper } from "./auto-transpose";
import type { TrackAssignment } from "./types";

export function octaveAllowed(track: Track, assignment: TrackAssignment, direction: number): boolean {
  const pitch = pitchMapper(noteRange(track.notes), assignment);
  return [...track.notes, ...assignment.unstrummedNotes ?? []].every(note =>
    pitch(note.midi) + direction * 12 >= 48 && pitch(note.midi) + direction * 12 <= 84);
}

export function hasChords(track: Track): boolean {
  return new Set(track.notes.map(note => note.ticks)).size < track.notes.length;
}

export function shiftOctave(track: Track, assignment: TrackAssignment, direction: number): void {
  if (!octaveAllowed(track, assignment, direction)) throw new Error("The octave shift would exceed C3–C6.");
  const pitch = pitchMapper(noteRange(track.notes), assignment);
  const range = noteRange(track.notes.map(note => ({ midi: pitch(note.midi) })));
  const previous = !assignment.autoTranspose && !assignment.transpose ? assignment.octaveShift : undefined;
  const octaves = (previous?.octaves ?? 0) + direction;
  assignment.octaveShift = octaves ? {
    octaves, minNote: previous?.minNote ?? range.minNote, maxNote: previous?.maxNote ?? range.maxNote,
  } : undefined;
  for (const note of track.notes) note.midi = pitch(note.midi) + direction * 12;
  for (const note of assignment.unstrummedNotes ?? []) note.midi = pitch(note.midi) + direction * 12;
  assignment.transpose = 0;
  assignment.autoTranspose = false;
}

export function undoStrum(track: Track, assignment: TrackAssignment): void {
  if (!assignment.unstrummedNotes) return;
  track.notes = [];
  for (const note of assignment.unstrummedNotes) track.addNote(note);
  delete assignment.unstrummedNotes;
}

export function strumTrack(source: Midi, index: number, rate: number) {
  const midi = new Midi();
  midi.fromJSON(source.toJSON());
  const track = midi.tracks[index];
  const groups = new Map<number, typeof track.notes>();
  for (const note of track.notes) {
    const group = groups.get(note.ticks) ?? [];
    group.push(note);
    groups.set(note.ticks, group);
  }
  const chords = [...groups].sort((a, b) => a[0] - b[0]);
  let removed = 0;
  let changed = 0;
  track.notes = chords.flatMap(([ticks, notes], index) => {
    if (notes.length === 1) return notes;
    changed++;
    notes.sort((a, b) => a.midi - b.midi);
    const start = midi.header.ticksToSeconds(ticks);
    const next = chords[index + 1]?.[0] ?? source.durationTicks;
    const endTick = Math.min(next, ...notes.map(note => note.ticks + note.durationTicks));
    const window = midi.header.ticksToSeconds(endTick) - start;
    const gap = .125 * rate;
    const hold = Math.min(window, Math.max(gap, window / 2));
    const count = Math.min(notes.length, 1 + Math.floor((window - hold + .000001) / gap));
    removed += notes.length - count;
    const selected = [notes[notes.length - 1]];
    if (count > 1) {
      selected.unshift(notes[0]);
      const middle = notes.slice(1, -1);
      const pitches = new Set(selected.map(note => note.midi % 12));
      while (selected.length < count) {
        const distinct = middle.findIndex(note => !pitches.has(note.midi % 12));
        const [note] = middle.splice(Math.max(0, distinct), 1);
        selected.push(note);
        pitches.add(note.midi % 12);
      }
      selected.sort((a, b) => a.midi - b.midi);
    }
    const starts = selected.map((_, i) => i === 0 ? ticks : midi.header.secondsToTicks(start + i * gap));
    return selected.map((note, i) => {
      note.ticks = starts[i];
      note.durationTicks = (starts[i + 1] ?? endTick) - note.ticks;
      return note;
    });
  });
  return { midi, removed, changed };
}
