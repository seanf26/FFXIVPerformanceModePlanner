import { parseMidi, writeMidi } from "midi-file";

export function trackChannel(position: number): number {
  const channel = position % 15;
  return Math.floor(position / 15) * 16 + (channel >= 9 ? channel + 1 : channel);
}

export function routeTracks(bytes: Uint8Array, durationTicks = 0): Uint8Array {
  const midi = parseMidi(bytes);
  if (durationTicks > 0) {
    const conductor = midi.tracks[0];
    // Use the full preview timeline even if the source has its own loop markers.
    conductor.forEach((event, index) => {
      if (event.type === "marker" && /^(start|loopstart|loopend)$/i.test(event.text.trim())) {
        conductor[index] = { ...event, type: "text" };
      }
    });
    conductor.unshift({ deltaTime: 0, meta: true, type: "marker", text: "loopstart" });
    const ticks = conductor.reduce((sum, event) => sum + event.deltaTime, 0);
    const end = conductor[conductor.length - 1];
    conductor.splice(conductor.length - 1, 0, {
      deltaTime: end.deltaTime + Math.max(0, durationTicks - ticks), meta: true, type: "marker", text: "loopend",
    });
    end.deltaTime = 0;
  }
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
