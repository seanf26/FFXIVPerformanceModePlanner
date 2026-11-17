import { Midi } from "@tonejs/midi";
import type { ParsedMidi } from "./midi-analysis";
import { summarizeMidi } from "./midi-analysis";
import type { TrackAssignment } from "./types";
import { noteRange, pitchMapper } from "./auto-transpose";
import { isTrackSelected } from "./composition";
import { stripExpression } from "./strip-expression";

export type MergeSnapshot = { midi: Midi; assignments: Record<number, TrackAssignment> };

function cloneMidi(source: Midi): Midi {
  const midi = new Midi();
  midi.fromJSON(source.toJSON());
  return midi;
}

export function snapshotMergeState(midi: Midi, assignments: Record<number, TrackAssignment>): MergeSnapshot {
  return { midi: cloneMidi(midi), assignments: structuredClone(assignments) };
}

export function mergeSelectedTracks(parsed: ParsedMidi, assignments: Record<number, TrackAssignment>, modificationSelection?: Set<number>) {
  const selected = parsed.summaries.map(s => s.index).filter(index =>
    modificationSelection ? modificationSelection.has(index) : isTrackSelected(assignments[index]));
  if (selected.length < 2) throw new Error("Check at least two tracks to merge.");

  const midi = cloneMidi(parsed.midi);
  const first = selected[0];
  const target = midi.tracks[first];
  const firstAssignment = assignments[first];
  const labels = new Map(parsed.summaries.map(s => [s.index, s.name]));
  target.notes = selected.flatMap(index => {
    const notes = midi.tracks[index].notes;
    const pitch = pitchMapper(noteRange(notes), assignments[index]);
    return notes.map(note => {
      const adapted = pitch(note.midi);
      if (adapted < 0 || adapted > 127) throw new Error("Merged notes must remain within the MIDI range.");
      note.midi = adapted;
      return note;
    });
  }).sort((a, b) => a.ticks - b.ticks);
  target.name = `Merged: ${selected.map(index => labels.get(index) ?? `Track ${index + 1}`).join(" + ")}`;
  target.instrument.number = firstAssignment.preset;
  stripExpression(target);

  const removed = new Set(selected.slice(1));
  const mergedAssignments: Record<number, TrackAssignment> = {};
  const remaining = [];
  let mergedIndex = first;
  for (const [oldIndex, track] of midi.tracks.entries()) {
    if (removed.has(oldIndex)) continue;
    const newIndex = remaining.length;
    remaining.push(track);
    if (oldIndex === first) {
      mergedIndex = newIndex;
      mergedAssignments[newIndex] = {
        selected: selected.some(index => isTrackSelected(assignments[index])),
        preset: firstAssignment.preset,
        transpose: 0,
        autoTranspose: false,
      };
    } else if (assignments[oldIndex]) {
      mergedAssignments[newIndex] = structuredClone(assignments[oldIndex]);
    }
  }
  midi.tracks = remaining;
  return { parsed: { midi, summaries: summarizeMidi(midi) }, assignments: mergedAssignments, count: selected.length, mergedIndex };
}

export function deleteTracks(parsed: ParsedMidi, assignments: Record<number, TrackAssignment>, modificationSelection: Set<number>) {
  const midi = cloneMidi(parsed.midi);
  const deleted = new Set(parsed.summaries.map(s => s.index).filter(index => modificationSelection.has(index)));
  const nextAssignments: Record<number, TrackAssignment> = {};
  const indexMap: Record<number, number> = {};
  const remaining = [];
  for (const [oldIndex, track] of midi.tracks.entries()) {
    if (deleted.has(oldIndex)) continue;
    const newIndex = remaining.length;
    remaining.push(track);
    indexMap[oldIndex] = newIndex;
    if (assignments[oldIndex]) nextAssignments[newIndex] = structuredClone(assignments[oldIndex]);
  }
  midi.tracks = remaining;
  return { parsed: { midi, summaries: summarizeMidi(midi) }, assignments: nextAssignments, count: deleted.size, indexMap };
}
