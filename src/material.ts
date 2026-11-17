export function materialIcon(name: string, fallback: string): string {
  return `<span class="material-icon" aria-hidden="true"><span class="material-symbol">${name}</span>${fallback}</span>`;
}

export function updateMaterialSlider(input: HTMLInputElement): void {
  const minimum = Number(input.min);
  const span = Number(input.max) - minimum;
  const progress = span > 0 ? (input.valueAsNumber - minimum) / span : 0;
  input.style.setProperty("--slider-progress", String(progress));
}

export function updateMaterialSliders(container: HTMLElement): void {
  container.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(updateMaterialSlider);
}

export const materialRollColors = {
  background: "#211a2a",
  darkLane: "#241d2d",
  lightLane: "#2d2537",
  outsideRange: "#b6656b22",
  octaveLine: "#645571",
  pitchLine: "#332940",
  darkKey: "#382f43",
  lightKey: "#d9cce5",
  keyText: "#2b2037",
  ruler: "#1c1724",
  rulerText: "#dcd0e7",
  playhead: "#d2bcff",
  dimmedNoteText: "#dfd8e4",
};

export const lightRollColors = {
  background: "#eee8f5",
  darkLane: "#e1d7eb",
  lightLane: "#eee5f6",
  outsideRange: "#b6656b16",
  octaveLine: "#a89ab6",
  pitchLine: "#ddd2e8",
  darkKey: "#655775",
  lightKey: "#f5eefb",
  keyText: "#2b2037",
  ruler: "#dfd4e9",
  rulerText: "#443853",
  playhead: "#644297",
  dimmedNoteText: "#443853",
};
