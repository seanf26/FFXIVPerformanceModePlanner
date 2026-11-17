import type { Track } from "@tonejs/midi";

export function stripExpression(track: Track): void {
  for (const controller of Object.keys(track.controlChanges)) {
    delete track.controlChanges[Number(controller)];
  }
  track.pitchBends.length = 0;
}
