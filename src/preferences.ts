export type Preferences = {
  theme: "dark" | "light";
  volume: number;
  timeZoom: number;
  pitchZoom: number;
  exportOptions: Record<string, boolean>;
};

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "dark",
  volume: .5,
  timeZoom: 80,
  pitchZoom: 14,
  exportOptions: {
    expanded: false,
    trimEmptySpace: false,
    keepUnselectedTracks: false,
  },
};

const STORAGE_KEY = "ffxiv-performance-preferences";
const LEGACY_THEME_KEY = "ffxiv-planner-theme";

export function loadPreferences(): Preferences {
  try {
    const storage = typeof localStorage === "undefined" ? null : localStorage;
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    const savedTheme = saved?.theme === "dark" || saved?.theme === "light" ? saved.theme : null;
    const legacyTheme = savedTheme ? null : storage?.getItem(LEGACY_THEME_KEY);
    const preferences: Preferences = {
      theme: savedTheme ?? (legacyTheme === "light" ? "light" : DEFAULT_PREFERENCES.theme),
      volume: bounded(saved?.volume, 0, 1, DEFAULT_PREFERENCES.volume),
      timeZoom: bounded(saved?.timeZoom, 25, 250, DEFAULT_PREFERENCES.timeZoom),
      pitchZoom: bounded(saved?.pitchZoom, 8, 26, DEFAULT_PREFERENCES.pitchZoom),
      exportOptions: {
        ...DEFAULT_PREFERENCES.exportOptions,
        ...booleanRecord(saved?.exportOptions),
      },
    };
    if (storage && (legacyTheme === "light" || legacyTheme === "dark")) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
        storage.removeItem(LEGACY_THEME_KEY);
      } catch {}
    }
    return preferences;
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(changes: Partial<Preferences>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPreferences(), ...changes }));
  } catch {}
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
}
