import { pitchMapper } from "./auto-transpose";
import { FFXIV_MIN_NOTE, FFXIV_MAX_NOTE, noteName } from "./ffxiv";
import type { TrackAssignment, TrackSummary } from "./types";

const TRACK_COLORS = [
  "#a5dcad", "#7ac9eb", "#f4c77c", "#e6a0be", "#c2b1ef", "#81d9cf",
  "#ef9a8d", "#c8d97e", "#8faae6", "#e8a66b", "#d896dc", "#a9b7c9",
];
export const DIMMED_NOTE_OPACITY = .3;
export function trackColor(position: number): string {
  return TRACK_COLORS[position % TRACK_COLORS.length];
}
export function trackTint(position: number, opacity = DIMMED_NOTE_OPACITY): string {
  return `${trackColor(position)}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`;
}

export function trackNeedsTranspose(summary: TrackSummary, assignment: TrackAssignment): boolean {
  return summary.minNote + assignment.transpose < FFXIV_MIN_NOTE ||
    summary.maxNote + assignment.transpose > FFXIV_MAX_NOTE;
}

export function rangeEndpoint(note: number, assignment: TrackAssignment, allTracks: boolean, range = { minNote: note, maxNote: note }) {
  const effective = pitchMapper(range, assignment, allTracks)(note);
  const playable = effective >= FFXIV_MIN_NOTE && effective <= FFXIV_MAX_NOTE;
  const label = noteName(note);
  if (!playable) return { label, className: "range-warning", message: `${noteName(effective)} is ${effective < FFXIV_MIN_NOTE ? "below" : "above"} the playable range C3-C6.` };
  if (effective !== note) return { label, className: "range-transposed", message: `Currently transposed: ${label} → ${noteName(effective)} (within playable range).` };
  return { label, className: "", message: "" };
}

export function shiftedRange(range: { minNote: number; maxNote: number }, assignment: TrackAssignment) {
  const shift = assignment.octaveShift;
  if (!shift) return null;
  const label = `${noteName(range.minNote)}–${noteName(range.maxNote)}*`;
  const count = Math.abs(shift.octaves);
  const message = `Shifted ${shift.octaves > 0 ? "up" : "down"} ${count} octave${count === 1 ? "" : "s"} · Original range: ${noteName(shift.minNote)}–${noteName(shift.maxNote)} · Current range: ${noteName(range.minNote)}–${noteName(range.maxNote)}`;
  const warning = rangeEndpoint(range.minNote, assignment, false, range).className === "range-warning" ||
    rangeEndpoint(range.maxNote, assignment, false, range).className === "range-warning";
  return { label, message, className: warning ? "range-warning" : "range-octave-shifted" };
}
