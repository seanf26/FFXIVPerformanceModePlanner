export const FFXIV_MIN_NOTE = 48;
export const FFXIV_MAX_NOTE = 84;

export const FFXIV_INSTRUMENTS = [
  { name: "Piano", program: 0 },
  { name: "Lute", program: 25 },
  { name: "Harp", program: 46 },
  { name: "Fiddle", program: 45 },
  { name: "Flute", program: 73 },
  { name: "Oboe", program: 68 },
  { name: "Clarinet", program: 71 },
  { name: "Fife", program: 72 },
  { name: "Panpipes", program: 75 },
  { name: "Timpani", program: 47 },
  { name: "Bongo", program: 96 },
  { name: "Bass Drum", program: 97 },
  { name: "Snare Drum", program: 98 },
  { name: "Cymbal", program: 99 },
  { name: "Trumpet", program: 56 },
  { name: "Trombone", program: 57 },
  { name: "Tuba", program: 58 },
  { name: "Horn", program: 60 },
  { name: "Saxophone", program: 65 },
  { name: "Violin", program: 40 },
  { name: "Viola", program: 41 },
  { name: "Cello", program: 42 },
  { name: "Double Bass", program: 43 },
  { name: "Electric Guitar: Clean", program: 27 },
  { name: "Electric Guitar: Muted", program: 28 },
  { name: "Electric Guitar: Overdriven", program: 29 },
  { name: "Electric Guitar: Power Chords", program: 30 },
  { name: "Electric Guitar: Special", program: 31 },
];

export function noteName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
