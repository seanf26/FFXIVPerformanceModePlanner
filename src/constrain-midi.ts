import { Midi } from "@tonejs/midi";
import { FFXIV_MAX_NOTE, FFXIV_MIN_NOTE } from "./ffxiv";
import type { ConstraintMode, TrackAssignment } from "./types";
import { routeTracks } from "./playback/routing";
import { noteRange, pitchMapper } from "./auto-transpose";
import { isTrackSelected } from "./composition";
import { stripExpression } from "./strip-expression";

export const PREVIEW_RULES = { constraintMode: "drop", simultaneousLimit: 1, minGapMs: 120 } as const;

export type ConstrainOptions = {
  assignments: Record<number, TrackAssignment>;
  constraintMode: ConstraintMode;
  simultaneousLimit: number;
  minGapMs: number;
  autoTranspose?: boolean;
};

export function createConstrainedMidi(source: Midi, options: ConstrainOptions): Uint8Array {
  const midi = new Midi();
  midi.fromJSON(source.toJSON());

  for (const [trackIndex, track] of midi.tracks.entries()) {
    const assignment = options.assignments[trackIndex];
    if (!assignment || !isTrackSelected(assignment)) continue;

    track.instrument.number = assignment.preset;
    stripExpression(track);

    const filtered = [];
    const pitch = pitchMapper(noteRange(track.notes), assignment, options.autoTranspose);

    for (const note of [...track.notes].sort((a, b) => a.ticks - b.ticks)) {
      note.velocity = 100 / 127;
      note.noteOffVelocity = 0;
      const shifted = pitch(note.midi);
      if (shifted < FFXIV_MIN_NOTE || shifted > FFXIV_MAX_NOTE) {
        if (options.constraintMode === "drop") continue;
        note.midi = Math.min(FFXIV_MAX_NOTE, Math.max(FFXIV_MIN_NOTE, shifted));
      } else {
        note.midi = shifted;
      }

      filtered.push(note);
    }

    const acceptedStarts = new Map<number, number>();
    let previousAcceptedStart = -Infinity;
    track.notes = filtered.filter(note => {
      const startBucket = Math.round(note.time * 1000);
      const atThisStart = acceptedStarts.get(startBucket) ?? 0;
      if (atThisStart >= options.simultaneousLimit ||
        (startBucket !== previousAcceptedStart && startBucket - previousAcceptedStart < options.minGapMs)) return false;
      acceptedStarts.set(startBucket, atThisStart + 1);
      previousAcceptedStart = startBucket;
      return true;
    });
    for (let i = 0; i < track.notes.length - 1; i++) {
      const note = track.notes[i];
      const next = track.notes[i + 1];
      note.durationTicks = Math.min(note.durationTicks, next.ticks - note.ticks);
    }
  }

  midi.tracks = midi.tracks.filter((_, index) => options.assignments[index] !== undefined && isTrackSelected(options.assignments[index]));
  return routeTracks(midi.toArray(), source.durationTicks);
}
