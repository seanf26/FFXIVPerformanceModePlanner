export function adaptNote(note: number): number {
  let key = note - 48;
  if (key < 0) key = (key + 1) % 12 + 11;
  else if (key > 36) key = (key - 1) % 12 + 25;
  return key + 48;
}
