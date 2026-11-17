import { parseMidi, writeMidi } from "midi-file";

export function trackChannel(position: number): number {
  const channel = position % 15;
  return Math.floor(position / 15) * 16 + (channel >= 9 ? channel + 1 : channel);
}

export function routeTracks(bytes: Uint8Array, durationTicks = 0): Uint8Array {
  const midi = parseMidi(bytes);
  for (const [position, events] of midi.tracks.slice(1).entries()) {
    const channel = trackChannel(position);
    for (const event of events) {
      if ("channel" in event) event.channel = channel % 16;
    }
    events.unshift({ deltaTime: 0, meta: true, type: "portPrefix", port: Math.floor(channel / 16) });
    const end = events.find((event) => event.type === "endOfTrack");
    if (end) {
      const ticks = events.reduce((sum, event) => sum + event.deltaTime, 0);
      end.deltaTime += Math.max(0, durationTicks - ticks);
    }
  }
  return new Uint8Array(writeMidi(midi));
}
