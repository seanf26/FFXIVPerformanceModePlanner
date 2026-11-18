export type ConstraintMode = "drop" | "clamp";

export type TrackAssignment = {
  selected: boolean;
  preset: number;
  transpose: number;
  autoTranspose: boolean;
  unstrummedNotes?: { midi: number; ticks: number; durationTicks: number; velocity: number; noteOffVelocity: number }[];
};

export type TrackSummary = {
  index: number;
  name: string;
  program: number;
  noteCount: number;
  minNote: number;
  maxNote: number;
};
