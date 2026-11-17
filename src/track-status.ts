import type { Track } from "@tonejs/midi";
import { adaptNote } from "./auto-transpose";
import { shouldAutoTranspose } from "./composition";
import { FFXIV_MAX_NOTE, FFXIV_MIN_NOTE } from "./ffxiv";
import type { TrackAssignment } from "./types";

export type TrackStatus = {
  level: "healthy" | "caution" | "warning";
  total: number;
  outOfRange: number;
  dropped: number;
  droppedPercent: number;
  tooltip: string;
};

const CAUTION_THRESHOLD = 25;
const WARNING_THRESHOLD = 50;
const SIMULTANEOUS_LIMIT = 1;
const MIN_GAP_MS = 120;

export function getTrackStatus(track: Track, assignment: TrackAssignment): TrackStatus {
  let outOfRange = 0;
  let dropped = 0;
  const acceptedStarts = new Map<number, number>();
  let previousAcceptedStart = -Infinity;

  for (const note of [...track.notes].sort((a, b) => a.ticks - b.ticks)) {
    const shifted = note.midi + assignment.transpose;
    const pitch = shouldAutoTranspose(assignment) ? adaptNote(shifted) : shifted;
    if (pitch < FFXIV_MIN_NOTE || pitch > FFXIV_MAX_NOTE) {
      outOfRange++;
      continue;
    }
    const start = Math.round(note.time * 1000);
    const simultaneous = acceptedStarts.get(start) ?? 0;
    if (simultaneous >= SIMULTANEOUS_LIMIT ||
      (start !== previousAcceptedStart && start - previousAcceptedStart < MIN_GAP_MS)) {
      dropped++;
      continue;
    }
    acceptedStarts.set(start, simultaneous + 1);
    previousAcceptedStart = start;
  }

  return createStatus(track.notes.length, outOfRange, dropped);
}

export function combineTrackStatuses(statuses: TrackStatus[]): TrackStatus {
  return createStatus(
    statuses.reduce((sum, status) => sum + status.total, 0),
    statuses.reduce((sum, status) => sum + status.outOfRange, 0),
    statuses.reduce((sum, status) => sum + status.dropped, 0),
  );
}

function createStatus(total: number, outOfRange: number, dropped: number): TrackStatus {
  const droppedPercent = total ? dropped / total * 100 : 0;
  const rangeIssue = outOfRange > 0;
  const level = (rangeIssue && droppedPercent > CAUTION_THRESHOLD) || droppedPercent > WARNING_THRESHOLD
    ? "warning"
    : rangeIssue || droppedPercent > CAUTION_THRESHOLD
      ? "caution"
      : "healthy";
  const rangeText = outOfRange
    ? `${outOfRange} of ${total} notes out of range. Consider transposing.`
    : "No notes out of range.";
  const dropText = dropped
    ? `${dropped} of ${total} notes (${formatPercent(droppedPercent)}) likely dropped by simultaneous or rapid-note limits.`
    : "No notes likely dropped by simultaneous or rapid-note limits.";
  return { level, total, outOfRange, dropped, droppedPercent, tooltip: `${rangeText} ${dropText}` };
}

function formatPercent(percent: number): string {
  return `${Number(percent.toFixed(1))}%`;
}
