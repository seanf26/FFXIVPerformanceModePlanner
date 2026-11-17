import type { Midi } from "@tonejs/midi";

type TimedEvent = { ticks: number };

export function trimEmptySpace(midi: Midi): void {
  const notes = midi.tracks.flatMap(track => track.notes);
  if (!notes.length) return;
  const start = Math.min(...notes.map(note => note.ticks));
  const end = Math.max(...notes.map(note => note.ticks + note.durationTicks));
  for (const note of notes) note.ticks -= start;
  midi.header.tempos = trimStateEvents(midi.header.tempos, start, end);
  midi.header.timeSignatures = trimStateEvents(midi.header.timeSignatures, start, end);
  midi.header.keySignatures = trimStateEvents(midi.header.keySignatures, start, end);
  midi.header.meta = midi.header.meta
    .filter(event => event.ticks >= start && event.ticks <= end)
    .map(event => ({ ...event, ticks: event.ticks - start }));
  midi.header.update();
}

function trimStateEvents<T extends TimedEvent>(events: T[], start: number, end: number): T[] {
  const active = events.filter(event => event.ticks <= start).at(-1);
  const result = events
    .filter(event => event.ticks > start && event.ticks <= end)
    .map(event => ({ ...event, ticks: event.ticks - start }));
  if (active) result.unshift({ ...active, ticks: 0 });
  return result;
}
