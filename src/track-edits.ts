import { Midi, type Track } from "@tonejs/midi";
import { noteRange, pitchMapper } from "./auto-transpose";
import { PREVIEW_RULES } from "./constrain-midi";
import { FFXIV_MIN_NOTE, FFXIV_MAX_NOTE } from "./ffxiv";
import type { TrackAssignment } from "./types";

export function octaveAllowed(track: Track, assignment: TrackAssignment, direction: number): boolean {
  const pitch = pitchMapper(noteRange(track.notes), assignment);
  return [...track.notes, ...assignment.unstrummedNotes ?? []].every(note =>
    pitch(note.midi) + direction * 12 >= 48 && pitch(note.midi) + direction * 12 <= 84);
}

function noteGroups(track: Track, rate: number): Track["notes"][] {
  const groups: Track["notes"][] = [];
  for (const note of [...track.notes].sort((a, b) => a.ticks - b.ticks)) {
    const group = groups.at(-1);
    const first = group?.[0];
    if (first && (note.ticks === first.ticks ||
        (note.time - first.time <= .025 * rate && note.time < first.time + first.duration &&
          note.duration >= .06 * rate))) {
      group.push(note);
    } else {
      groups.push([note]);
    }
  }
  return groups;
}

type Note = Track["notes"][number];

function chordDuration(notes: Note[]): number {
  const ends = new Map<number, number>();
  for (const note of notes) {
    const end = note.time + note.duration - notes[0].time;
    ends.set(note.midi, Math.max(ends.get(note.midi) ?? 0, end));
  }
  const durations = [...ends.values()].sort((a, b) => a - b);
  return durations[Math.floor((durations.length - 1) / 2)] ?? 0;
}

function isWeakHit(notes: Note[], next: Note[] | undefined, chord: Note[], rate: number, ppq: number): boolean {
  const [note] = notes;
  if (notes.length !== 1 || next?.length !== 1 || note.duration >= .06 * rate ||
      note.time - chord[0].time > chordDuration(chord) + .125 * rate ||
      next[0].time - note.time >= PREVIEW_RULES.minGapMs * rate / 1000) return false;
  const step = ppq / 8;
  const gridDistance = Math.abs(note.ticks - Math.round(note.ticks / step) * step);
  return gridDistance > ppq / 96 && Math.abs(note.midi - next[0].midi) > 5 &&
    chord.every(tone => Math.abs(tone.midi - note.midi) > 5);
}

function canStrum(notes: Track["notes"], next: Track["notes"] | undefined, rate: number): boolean {
  if (new Set(notes.map(note => note.midi)).size < 3) return false;
  const untilNext = next ? next[0].time - notes[0].time : Infinity;
  return Math.min(untilNext, chordDuration(notes)) + .000001 >= .25 * rate;
}

export function hasChords(track: Track, rate: number, ppq = 480): boolean {
  return noteGroups(track, rate).some((notes, index, groups) => {
    const next = groups[index + 1];
    return canStrum(notes, next && isWeakHit(next, groups[index + 2], notes, rate, ppq)
      ? groups[index + 2] : next, rate);
  });
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

export function strumTrack(source: Midi, index: number, rate: number, assignment?: TrackAssignment) {
  const midi = new Midi();
  midi.fromJSON(source.toJSON());
  const track = midi.tracks[index];
  const originalCount = track.notes.length;
  const pitch = pitchMapper(noteRange(track.notes), assignment);
  const minGap = PREVIEW_RULES.minGapMs * rate;
  const gap = .125 * rate;
  const groups = noteGroups(track, rate);
  const planned: Note[] = [];
  let changed = 0;
  for (let i = 0; i < groups.length; i++) {
    const notes = groups[i];
    const following = groups[i + 1];
    const weak = following && isWeakHit(following, groups[i + 2], notes, rate, midi.header.ppq);
    const nextGroup = weak ? groups[i + 2] : following;
    if (!canStrum(notes, nextGroup, rate)) {
      planned.push(...notes);
      continue;
    }
    const { ticks } = notes[0];
    const byPitch = new Map<number, Note>();
    for (const note of notes) {
      const mapped = pitch(note.midi);
      if (assignment && (mapped < FFXIV_MIN_NOTE || mapped > FFXIV_MAX_NOTE)) continue;
      const existing = byPitch.get(mapped);
      if (!existing || note.ticks + note.durationTicks > existing.ticks + existing.durationTicks) {
        byPitch.set(mapped, note);
      }
    }
    const voicing = [...byPitch.values()].sort((a, b) => a.midi - b.midi);
    if (!voicing.length) {
      planned.push(...notes);
      continue;
    }
    const start = notes[0].time;
    const end = Math.min(nextGroup?.[0].time ?? Infinity, start + chordDuration(notes));
    const endTick = midi.header.secondsToTicks(end);
    const window = end - start;
    const hold = Math.min(window, Math.max(gap, window / 2));
    const previous = planned.at(-1);
    const bucket = (time: number) => Math.round(time * 1000);
    // Keep a nearby original attack in place and allow for tick rounding.
    const starts: number[] = [];
    for (let slot = 0; slot < 4 && slot * gap <= window - hold + .000001; slot++) {
      const tick = slot === 0 ? ticks : midi.header.secondsToTicks(start + slot * gap);
      const time = midi.header.ticksToSeconds(tick);
      const last = starts.at(-1);
      const before = last === undefined ? previous?.time : midi.header.ticksToSeconds(last);
      if (before !== undefined && (tick === last || bucket(time) - bucket(before) < minGap)) continue;
      if (nextGroup && bucket(nextGroup[0].time) - bucket(time) < minGap) break;
      starts.push(tick);
    }
    if (!starts.length) {
      planned.push(...notes);
      continue;
    }
    const next = nextGroup?.[0];
    const nearbyLead = nextGroup?.length === 1 && next && next.time - start <= 5 * gap
      ? voicing.filter(note => Math.abs(note.midi - next.midi) <= 2) : [];
    const lead = nearbyLead.length === 1 ? nearbyLead[0] : voicing.at(-1)!;
    const anchorLead = nearbyLead.length === 1;
    const bass = voicing[0];
    const selected = [lead];
    const repeats = (note: Note, time: number) =>
      [...(nextGroup ?? []), ...(previous ? [previous] : [])].some(other =>
        pitch(other.midi) === pitch(note.midi) && Math.abs(other.time - time) < 2 * gap - .000001);
    if (starts.length > 1 && bass !== lead) selected.push(bass);
    const middle = voicing.filter(note => note !== lead && note !== bass);
    while (selected.length < starts.length && middle.length) {
      const classes = new Set(selected.map(note => pitch(note.midi) % 12));
      const distinct = middle.findIndex(note => !classes.has(pitch(note.midi) % 12));
      selected.push(...middle.splice(Math.max(0, distinct), 1));
    }
    selected.sort((a, b) => a.midi - b.midi);
    if (anchorLead) selected.unshift(...selected.splice(selected.indexOf(lead), 1));
    const attacks = selected.flatMap((note, slot) => {
      const tick = starts[slot];
      if (note !== lead && (tick >= note.ticks + note.durationTicks ||
          (tick !== note.ticks && repeats(note, midi.header.ticksToSeconds(tick))))) return [];
      return [{ note, tick, end: note.ticks + note.durationTicks }];
    });
    attacks.forEach(({ note, tick, end }, slot) => {
      note.ticks = tick;
      note.durationTicks = Math.max(1, Math.min(end, attacks[slot + 1]?.tick ?? endTick) - tick);
      planned.push(note);
    });
    if (weak && next && bucket(next.time) - bucket(following[0].time) < minGap) i++;
    changed++;
  }
  track.notes = planned;
  return { midi, removed: originalCount - planned.length, changed };
}
