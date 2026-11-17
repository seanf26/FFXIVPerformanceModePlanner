type FollowFrame = { now: number; playing: boolean; enabled: boolean; playhead: number; left: number; width: number; maxLeft: number };

export function createFollowController() {
  let holdUntil = 0;
  let dragging = false;
  let transition: { start: number; left: number } | null = null;
  const manual = (now: number) => { holdUntil = now + 3000; transition = null; };
  return {
    manual,
    drag(active: boolean, now: number) { dragging = active; manual(now); },
    reset() { holdUntil = 0; dragging = false; transition = null; },
    next(frame: FollowFrame): number {
      const { now, playing, enabled, playhead, left, width, maxLeft } = frame;
      if (!playing || !enabled || dragging || now < holdUntil || width <= 0) {
        transition = null;
        return left;
      }
      const x = playhead - left;
      if (!transition && (x < 0 || x > width - Math.min(60, width / 4))) {
        transition = { start: now, left };
      }
      if (!transition) return left;
      const target = Math.max(0, Math.min(maxLeft, playhead - width * .25));
      const progress = Math.min(1, (now - transition.start) / 550);
      const eased = progress * progress * (3 - 2 * progress);
      const result = transition.left + (target - transition.left) * eased;
      if (progress === 1) transition = null;
      return Math.max(0, Math.min(maxLeft, result));
    },
  };
}
