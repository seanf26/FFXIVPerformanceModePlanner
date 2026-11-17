import { Midi, type Track } from "@tonejs/midi";
import { summarizeMidi, type ParsedMidi } from "./midi-analysis";
import type { TrackAssignment } from "./types";

const drumParts = [
  { name: "Bass Drum", program: 97, pitches: [35, 36] },
  { name: "Snare Drum", program: 98, pitches: [37, 38, 40] }, // Side stick uses the snare preset too.
];

export function getDrumSplit(track: Track) {
  if (track.channel !== 9) return null;
  // A dedicated clap part can contain a few kick or snare hits.
  const claps = track.notes.filter(note => note.midi === 39).length;
  if (claps > track.notes.length / 2) return null;
  const parts = drumParts.map(part => ({
    ...part, notes: track.notes.filter(note => part.pitches.includes(note.midi)),
  })).filter(part => part.notes.length);
  if (!parts.length) return null;
  return { parts, dropped: track.notes.length - parts.reduce((sum, part) => sum + part.notes.length, 0) };
}

export function splitDrums(parsed: ParsedMidi, assignments: Record<number, TrackAssignment>, index: number) {
  const source = parsed.midi.tracks[index];
  const split = getDrumSplit(source);
  if (!split) throw new Error("This track is not eligible for a bass drum or snare split.");

  const midi = new Midi();
  midi.fromJSON(parsed.midi.toJSON());
  const occupied = new Set(midi.tracks.filter(track => track.notes.length).map(track => track.channel));
  const channels = Array.from({ length: 16 }, (_, channel) => channel)
    .filter(channel => channel !== 9 && !occupied.has(channel));
  if (channels.length < split.parts.length) {
    throw new Error(`The split needs ${split.parts.length === 1 ? "one free MIDI channel" : "two free MIDI channels"} for the drum parts.`);
  }
  const tracks = split.parts.map((part, i) => {
    const track = midi.addTrack();
    track.name = part.name;
    track.channel = channels[i];
    track.instrument.number = part.program;
    track.endOfTrackTicks = source.endOfTrackTicks;
    for (const { ticks, durationTicks, velocity, noteOffVelocity } of part.notes) {
      track.addNote({ midi: 60, ticks, durationTicks, velocity, noteOffVelocity });
    }
    return track;
  });
  midi.tracks.length -= tracks.length;
  midi.tracks.splice(index, 1, ...tracks);

  const nextAssignments: Record<number, TrackAssignment> = {};
  for (const [key, assignment] of Object.entries(assignments)) {
    const oldIndex = Number(key);
    if (oldIndex !== index) nextAssignments[oldIndex < index ? oldIndex : oldIndex + tracks.length - 1] = assignment;
  }
  split.parts.forEach((part, i) => {
    nextAssignments[index + i] = {
      selected: assignments[index].selected, preset: part.program, transpose: 0, autoTranspose: false,
    };
  });
  return { parsed: { midi, summaries: summarizeMidi(midi) }, assignments: nextAssignments };
}
