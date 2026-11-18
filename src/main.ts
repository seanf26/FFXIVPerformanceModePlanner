import "./styles.css";
import { createConstrainedMidi, PREVIEW_RULES } from "./constrain-midi";
import { FFXIV_INSTRUMENTS, suggestedInstrument } from "./ffxiv";
import { parseMidi, summarizeMidi, type ParsedMidi } from "./midi-analysis";
import { SpessaPlayer } from "./playback/spessa-player";
import type { TrackAssignment } from "./types";
import { createPianoRoll } from "./piano-roll/piano-roll";
import { isTrackSelected } from "./composition";
import { bindTrackSelection } from "./track-selection";
import { rangeEndpoint, trackColor, trackNeedsTranspose, trackTint } from "./track-presentation";
import { combineTrackStatuses, getTrackStatus, type TrackStatus } from "./track-status";
import { loadPreferences, savePreferences } from "./preferences";
import { formatTime } from "./time";
import { createMidiExport } from "./midi-export";
import { originalBpm, tempoRate, MIN_BPM, MAX_BPM } from "./tempo";
import { deleteTracks, mergeSelectedTracks, snapshotMergeState, type MergeSnapshot } from "./merge-tracks";
import { getDrumSplit, splitDrums } from "./split-drums";
import { hasChords, octaveAllowed, shiftOctave, strumTrack, undoStrum } from "./track-edits";
import { lightRollColors, materialIcon, materialRollColors, updateMaterialSlider, updateMaterialSliders } from "./material";

const preferences = loadPreferences();
let lightTheme = preferences.theme === "light";
document.documentElement.dataset.theme = preferences.theme;
const resetIcon = '<svg width="20" height="20" viewBox="-0.5 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4 4 8l4 4M4 8h9a6 6 0 1 1-6 6"/></svg>';
const expandIcon = materialIcon("expand_more", '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>');
const symbolStyles = document.querySelector<HTMLLinkElement>("#material-symbols-font");
if (symbolStyles) {
  const activateSymbols = () => {
    symbolStyles.media = "all";
    void document.fonts.load('24px "Material Symbols Rounded"').then(fonts => {
      if (fonts.length) document.documentElement.classList.add("material-symbols-loaded");
    }).catch(() => {});
  };
  if (symbolStyles.sheet) activateSymbols();
  else symbolStyles.addEventListener("load", activateSymbols, { once: true });
}
const state = {
  filename: null as string | null,
  parsedMidi: null as ParsedMidi | null,
  assignments: {} as Record<number, TrackAssignment>,
  isPlaying: false,
  isPaused: false,
  isPreparing: false,
  isImporting: false,
  startTime: 0,
  sourceBpm: 120,
  targetBpm: 120,
  volume: preferences.volume,
  exportOptions: { ...preferences.exportOptions },
  message: "Load a MIDI file to begin.",
  messageIsError: false,
};
let player = new SpessaPlayer();
player.setVolume(state.volume);
let generation = 0;
let renderGeneration = 0;
let seekDragging = false;
let playbackUiFrame = 0;
let hoveredTrack: number | null = null;
type EditHistoryEntry = { snapshot: MergeSnapshot; checkedTracks: number[]; action: "merge" | "deletion" };
const editHistory: EditHistoryEntry[] = [];
const checkedTracks = new Set<number>();
let trackObserver: ResizeObserver | null = null;
const root = document.querySelector<HTMLDivElement>("#app")!;
root.addEventListener("input", event => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.type === "range") updateMaterialSlider(input);
});
const pianoRoll = (() => {
  try {
    const roll = createPianoRoll(() => ({
      parsed: state.parsedMidi, assignments: state.assignments,
      autoTranspose: false,
      time: state.isPlaying || state.isPaused ? player.currentTime : state.startTime,
      playing: state.isPlaying && !state.isPreparing,
    }), (time) => {
      if (!state.parsedMidi || state.isPreparing || state.isImporting) return;
      state.startTime = Math.max(0, Math.min(time, state.parsedMidi.midi.duration));
      if (state.isPlaying || state.isPaused) player.seek(state.startTime);
      pianoRoll?.invalidate();
    }, setHoveredTrack, lightTheme ? lightRollColors : materialRollColors);
    const zoomReset = roll.element.querySelector(".zoom-reset")!;
    zoomReset.innerHTML = resetIcon;
    zoomReset.addEventListener("click", () => updateMaterialSliders(roll.element));
    return roll;
  } catch (error) {
    console.error("Piano roll unavailable", error);
    return null;
  }
})();

function resetPlayback(): void {
  generation++;
  player.dispose();
  player = new SpessaPlayer();
  player.setVolume(state.volume);
  state.isPlaying = state.isPaused = state.isPreparing = false;
  state.startTime = 0;
}

function render(): void {
  const renderTicket = ++renderGeneration;
  const pageScroll = [window.scrollX, window.scrollY] as const;
  const focused = document.activeElement as HTMLElement | null;
  const focusedTrack = focused?.dataset.track;
  const focusedAction = focused?.dataset.action;
  trackObserver?.disconnect();
  const previousTracks = root.querySelector<HTMLDivElement>(".table-wrap");
  const trackScroll = [previousTracks?.scrollLeft ?? 0, previousTracks?.scrollTop ?? 0];
  const rollViewport = pianoRoll?.element.querySelector(".roll-viewport");
  const rollScroll = [rollViewport?.scrollLeft ?? 0, rollViewport?.scrollTop ?? 0];
  root.innerHTML = `
    <main class="shell">
      <section class="topbar">
        <div><p class="eyebrow">github.com/seanf26</p><h1>FFXIV Performance Mode Planner</h1></div>
        <button id="theme-toggle" class="secondary" type="button"></button>
      </section>
      ${state.messageIsError
        ? `<p class="material-error" role="alert">${escapeHtml(state.message)}</p>`
        : `<div class="material-announcement" role="status">${escapeHtml(state.message)}</div>`}
      <section class="grid">
        <aside class="stack">
          <div class="panel stack files-panel">
            <h2>Files</h2>
            <div class="field">
              ${renderFilePicker(state.filename)}
            </div>
            <button id="export-button" class="secondary labeled-icon" ${canExport() ? "" : "disabled"}>${interfaceIcon("save")}<span>Export MIDI</span></button>
            <details class="export-options" ${state.exportOptions.expanded ? "open" : ""}>
              <summary>Export options${expandIcon}</summary>
              <div class="export-options-drawer">
                <div class="export-options-fields">
                  <label title="Remove silence before the first and after the last exported note"><input data-export-option="trimEmptySpace" type="checkbox" ${state.exportOptions.trimEmptySpace ? "checked" : ""} /> Trim empty space</label>
                  <label><input data-export-option="keepUnselectedTracks" type="checkbox" ${state.exportOptions.keepUnselectedTracks ? "checked" : ""} /> Keep unselected tracks</label>
                </div>
              </div>
            </details>
          </div>
          <div class="panel stack playback-panel">
            <h2>Playback</h2>
            <div class="playback-controls">
              <div class="transport">
                <button id="play-button" class="icon-button" aria-label="${state.isPlaying ? "Pause" : state.isPaused ? "Resume" : "Play"}" title="${state.isPlaying ? "Pause" : state.isPaused ? "Resume" : "Play"}" ${canPreview() ? "" : "disabled"}>${interfaceIcon(state.isPlaying ? "pause" : "play")}</button>
                <button id="stop-button" class="secondary icon-button" aria-label="Stop" title="Stop" ${state.isPlaying || state.isPaused || state.isPreparing ? "" : "disabled"}>${interfaceIcon("stop")}</button>
                <div class="volume-control">
                  <button id="volume-button" class="secondary icon-button" type="button" aria-label="Volume ${Math.round(state.volume * 100)}%" aria-expanded="false" title="Volume ${Math.round(state.volume * 100)}%"><span id="volume-icon">${volumeIcon(state.volume)}</span></button>
                  <div id="volume-popover" class="volume-popover" hidden><input id="volume-input" type="range" min="0" max="100" step="1" value="${Math.round(state.volume * 100)}" aria-label="Playback volume" /></div>
                </div>
              </div>
              ${renderTempoControl()}
            </div>
            <div class="playback-seek">
              <output id="seek-current" aria-label="Elapsed time">${formatTime(playbackTime())}</output>
              <input id="seek-input" type="range" min="0" max="${state.parsedMidi?.midi.duration ?? 0}" step="0.01" value="${playbackTime()}" aria-label="Playback position" ${state.parsedMidi ? "" : "disabled"} />
              <output id="seek-total" aria-label="Total time">${formatTime(state.parsedMidi?.midi.duration ?? 0)}</output>
            </div>
            <p class="playback-state">${playbackState()}</p>
          </div>
        </aside>
        <section class="panel tracks-panel"><div class="tracks-heading"><h2>Tracks</h2><div class="track-actions">
          <!-- <button id="deselect-all-button" class="secondary compact" ${selectedTrackCount() && !state.isPreparing && !state.isImporting ? "" : "disabled"}>Deselect all</button> -->
          <button id="undo-edit-button" class="secondary compact" title="Undo the most recent merge or deletion" ${editHistory.length && !state.isPreparing && !state.isImporting ? "" : "disabled"}>Undo</button>
          <button id="merge-button" class="secondary compact" title="Merge checked tracks" ${checkedTrackCount() >= 2 && !state.isPreparing && !state.isImporting ? "" : "disabled"}>Merge</button>
          <!-- <button id="transpose-checked-button" class="secondary compact" title="Transpose checked tracks into C3–C6" ${checkedTrackCount() && !state.isPreparing && !state.isImporting ? "" : "disabled"}>Transpose checked</button> -->
          <button id="delete-tracks-button" class="secondary compact track-icon-button" type="button" aria-label="Delete checked tracks" title="Delete checked tracks" ${checkedTrackCount() && !state.isPreparing && !state.isImporting ? "" : "disabled"}>${interfaceIcon("delete")}</button>
        </div><strong>${selectedTrackCount()} of ${state.parsedMidi?.summaries.length ?? 0} tracks selected for playback</strong></div>${renderTracks()}${renderCompositionStatus()}</section>
      </section>
    </main>`;
  bindEvents();
  highlightTrackRow();
  if (focusedTrack !== undefined && focusedAction) {
    root.querySelector<HTMLElement>(`[data-track="${focusedTrack}"][data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  }
  const trackViewport = root.querySelector<HTMLDivElement>(".table-wrap");
  if (trackViewport) {
    const table = trackViewport.querySelector("table")!;
    const rows = table.tBodies[0].rows;
    if (rows.length > 6) {
      const sizeTracks = () => {
        const bottom = rows[5].getBoundingClientRect().bottom;
        const scrollbar = trackViewport.offsetHeight - trackViewport.clientHeight;
        trackViewport.style.maxHeight = `${bottom - table.getBoundingClientRect().top + scrollbar}px`;
      };
      sizeTracks();
      trackObserver = new ResizeObserver(sizeTracks);
      trackObserver.observe(table);
    }
    trackViewport.scrollLeft = trackScroll[0];
    trackViewport.scrollTop = trackScroll[1];
  }
  if (pianoRoll) {
    root.querySelector("main")!.append(pianoRoll.element);
    if (rollViewport) {
      rollViewport.scrollLeft = rollScroll[0];
      rollViewport.scrollTop = rollScroll[1];
    }
    pianoRoll.invalidate();
  }
  updateMaterialSliders(root);
  window.scrollTo(pageScroll[0], pageScroll[1]);
  requestAnimationFrame(() => {
    if (renderTicket === renderGeneration) window.scrollTo(pageScroll[0], pageScroll[1]);
  });
}

function playbackState(): string {
  if (state.isImporting) return "Loading MIDI…";
  if (state.isPreparing) return "Preparing preview…";
  if (state.isPlaying) return "Playing preview";
  if (state.isPaused) return "Preview paused";
  if (!state.parsedMidi) return "No MIDI loaded";
  if (!selectedTrackCount()) return "No tracks selected for playback";
  return "Ready to play";
}

function renderTempoControl(): string {
  const input = `<input id="tempo-input" aria-label="Tempo in BPM" type="text" inputmode="decimal" spellcheck="false" value="${formatBpm(state.targetBpm)}" ${state.parsedMidi ? "" : "disabled"} />`;
  const resetLabel = `Reset tempo to ${formatBpm(state.sourceBpm)} BPM`;
  return `<div class="tempo-control">
    <div class="tempo-stepper">
      <button id="tempo-down" type="button" aria-label="Decrease tempo by 1 BPM" title="Decrease tempo by 1 BPM" ${canStepTempo(-1) ? "" : "disabled"}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 6h8"/></svg></button>
      <div class="tempo-value">${input}<label for="tempo-input">BPM</label></div>
      <button id="tempo-up" type="button" aria-label="Increase tempo by 1 BPM" title="Increase tempo by 1 BPM" ${canStepTempo(1) ? "" : "disabled"}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 6h8M6 2v8"/></svg></button>
    </div>
    <button id="tempo-reset" class="tempo-reset" type="button" aria-label="${resetLabel}" title="${resetLabel}" ${canResetTempo() ? "" : "disabled"}>${resetIcon}</button>
  </div>`;
}

function renderFilePicker(filename: string | null): string {
  const name = escapeHtml(filename ?? "No file chosen");
  return `<div class="file-picker">
    <input id="midi-input" type="file" accept=".mid,.midi" title="${name}" aria-describedby="midi-input-name" aria-label="Open MIDI" />
    <span class="file-picker-button" aria-hidden="true">${interfaceIcon("folder")}<span>Open MIDI</span></span>
    <span class="file-picker-name" id="midi-input-name" title="${name}">${name}</span>
  </div>`;
}

function renderTracks(): string {
  const parsed = state.parsedMidi;
  if (!parsed?.summaries.length) return `<div class="empty">No playable tracks loaded.</div>`;
  const rows = parsed.summaries.map((summary, position) => {
    const assignment = state.assignments[summary.index];
    const status = getTrackStatus(parsed.midi.tracks[summary.index], assignment);
    const name = escapeHtml(summary.name);
    const suggestion = getDrumSplit(parsed.midi.tracks[summary.index]) ? "split-drums" :
      !assignment.autoTranspose && trackNeedsTranspose(summary, assignment) ? "transpose" : null;
    return `<tr tabindex="0" style="--track-color: ${trackColor(position)}; --track-tint: ${trackTint(position)}; --track-excluded-hover: ${trackTint(position, .18)}" aria-selected="${isTrackSelected(assignment)}" aria-label="${name}: ${isTrackSelected(assignment) ? "included in" : "excluded from"} composition" data-action="selected" data-track="${summary.index}" class="${isTrackSelected(assignment) ? "track-selected" : "track-excluded"}">
      <td class="modification-cell"><input aria-label="Check ${name} for modification" data-action="modify" data-track="${summary.index}" type="checkbox" ${checkedTracks.has(summary.index) ? "checked" : ""} ${state.isPreparing || state.isImporting ? "disabled" : ""} /></td>
      <td><div class="track-name" title="${name}">${name}</div></td>
      <td>${summary.noteCount}</td>
      <td>${renderRangeEndpoint(summary.minNote, assignment, summary)}-${renderRangeEndpoint(summary.maxNote, assignment, summary)}</td>
      <td><select aria-label="Instrument for ${name}" data-action="preset" data-track="${summary.index}">
        ${FFXIV_INSTRUMENTS.map((instrument) => `<option value="${instrument.program}" ${instrument.program === assignment.preset ? "selected" : ""}>${escapeHtml(instrument.name)}</option>`).join("")}
      </select></td>
      <td class="status-cell">${renderTrackStatus(status)}</td>
      <td><button type="button" class="secondary track-edit ${suggestion ? "has-suggestion" : ""}" title="${suggestion === "split-drums" ? "Suggested: split drumset" : suggestion ? "Suggested: transpose to range" : "Track options"}" data-action="edit" data-track="${summary.index}" aria-haspopup="menu" aria-expanded="false" aria-label="Edit ${name}" ${state.isPreparing || state.isImporting ? "disabled" : ""}>Edit ${expandIcon}</button></td>
    </tr>`;
  }).join("");
  const allChecked = checkedTrackCount() === parsed.summaries.length;
  return `<div class="table-wrap"><table><colgroup><col class="modification-column" /><col class="track-column" /><col class="notes-column" /><col class="range-column" /><col class="instrument-column" /><col class="status-column" /><col class="edit-column" /></colgroup><thead><tr><th class="modification-cell"><input id="modify-all" type="checkbox" aria-label="Check all tracks for modification" title="Check all tracks for modification" ${allChecked ? "checked" : ""} ${state.isPreparing || state.isImporting ? "disabled" : ""} /></th><th>Track</th><th>Notes</th><th>Range</th><th>Instrument</th><th class="status-cell">Status</th><th aria-label="Track actions"></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderCompositionStatus(): string {
  if (!state.parsedMidi) return "";
  const statuses = state.parsedMidi.summaries
    .filter(summary => isTrackSelected(state.assignments[summary.index]))
    .map(summary => getTrackStatus(state.parsedMidi!.midi.tracks[summary.index], state.assignments[summary.index]));
  if (!statuses.length) {
    return `<div class="composition-status status-caution">${interfaceIcon("statusCaution")}<span>No tracks selected.</span></div>`;
  }
  const status = combineTrackStatuses(statuses);
  const icon = status.level === "healthy" ? "statusHealthy" : status.level === "caution" ? "statusCaution" : "statusWarning";
  return `<div class="composition-status status-${status.level}" title="${escapeHtml(status.tooltip)}">${interfaceIcon(icon)}<span>${escapeHtml(status.tooltip)}</span></div>`;
}

async function importMidi(file: File): Promise<void> {
  resetPlayback();
  const ticket = generation;
  state.isImporting = true;
  setMessage(`Loading ${file.name}...`);
  render();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (ticket !== generation) return;
    const parsed = parseMidi(bytes);
    editHistory.length = 0;
    checkedTracks.clear();
    state.filename = file.name;
    state.parsedMidi = parsed;
    state.assignments = {};
    state.sourceBpm = originalBpm(parsed.midi);
    state.targetBpm = state.sourceBpm;
    for (const summary of parsed.summaries) {
      state.assignments[summary.index] = {
        selected: true,
        preset: suggestedInstrument(summary.program, parsed.midi.tracks[summary.index].name,
          parsed.midi.tracks[summary.index].channel === 9),
        transpose: 0,
        autoTranspose: false,
      };
    }
    setMessage(`Loaded ${file.name}.`);
  } catch (error) {
    if (ticket === generation) setMessage(errorMessage(error), true);
  } finally {
    if (ticket === generation) { state.isImporting = false; render(); }
  }
}

async function play(): Promise<void> {
  if (state.isPlaying) {
    player.pause();
    state.isPlaying = false;
    state.isPaused = true;
    setMessage("Playback paused.");
    render();
    return;
  }
  if (!canPreview()) return;
  const ticket = generation;
  const session = player;
  state.isPreparing = true;
  setMessage("Preparing preview...");
  render();
  try {
    if (state.isPaused) await session.resume();
    else {
      const midi = state.parsedMidi!.midi;
      const name = state.filename!;
      const assignments = state.assignments;
      session.onEnded = () => {
        if (ticket !== generation) return;
        state.isPlaying = state.isPaused = false;
        state.startTime = 0;
        setMessage("Playback finished.");
        render();
      };
      await session.loadSoundFont();
      if (ticket !== generation) return;
      const audible = Object.fromEntries(Object.entries(assignments).map(([key, a]) => [key, { ...a, selected: true }]));
      const bytes = createConstrainedMidi(midi, { assignments: audible, ...PREVIEW_RULES,
        minGapMs: PREVIEW_RULES.minGapMs * tempoRate(state.targetBpm, state.sourceBpm), autoTranspose: false });
      session.setPlaybackRate(tempoRate(state.targetBpm, state.sourceBpm));
      await session.play(bytes, name, assignments, state.startTime);
    }
    if (ticket !== generation) return;
    state.isPlaying = true;
    state.isPaused = false;
    setMessage("Playing preview.");
  } catch (error) {
    if (ticket !== generation) return;
    resetPlayback();
    setMessage(errorMessage(error), true);
    render();
  } finally {
    if (ticket === generation) { state.isPreparing = false; render(); }
  }
}

function bindEvents(): void {
  const themeToggle = root.querySelector<HTMLButtonElement>("#theme-toggle");
  if (themeToggle) {
    const updateThemeButton = () => {
      const label = lightTheme ? "Switch to dark theme" : "Switch to light theme";
      const path = lightTheme
        ? "M20 15.1A8.5 8.5 0 0 1 8.9 4a8.5 8.5 0 1 0 11.1 11.1Z"
        : "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z";
      themeToggle.setAttribute("aria-label", label);
      themeToggle.title = label;
      themeToggle.innerHTML = materialIcon(lightTheme ? "dark_mode" : "light_mode", `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="${path}"/></svg>`);
    };
    updateThemeButton();
    themeToggle.addEventListener("click", () => {
      lightTheme = !lightTheme;
      document.documentElement.dataset.theme = lightTheme ? "light" : "dark";
      savePreferences({ theme: lightTheme ? "light" : "dark" });
      pianoRoll?.setColors(lightTheme ? lightRollColors : materialRollColors);
      updateThemeButton();
    });
  }
  root.querySelectorAll<HTMLTableRowElement>('tr[data-action="selected"]').forEach(row => {
    row.addEventListener("pointerenter", () => pianoRoll?.highlightTrack(Number(row.dataset.track)));
    row.addEventListener("pointerleave", () => pianoRoll?.highlightTrack(null));
  });
  const modifyAll = document.getElementById("modify-all") as HTMLInputElement | null;
  if (modifyAll) {
    modifyAll.indeterminate = checkedTrackCount() > 0 && !modifyAll.checked;
    modifyAll.addEventListener("change", () => {
      checkedTracks.clear();
      if (modifyAll.checked) for (const summary of state.parsedMidi?.summaries ?? []) checkedTracks.add(summary.index);
      render();
    });
  }
  const exportOptions = document.querySelector<HTMLDetailsElement>(".export-options")!;
  exportOptions.addEventListener("toggle", () => {
    state.exportOptions.expanded = exportOptions.open;
    savePreferences({ exportOptions: state.exportOptions });
  });
  root.querySelectorAll<HTMLInputElement>("input[data-export-option]").forEach(input => {
    input.addEventListener("change", () => {
      state.exportOptions[input.dataset.exportOption!] = input.checked;
      savePreferences({ exportOptions: state.exportOptions });
      (document.getElementById("export-button") as HTMLButtonElement).disabled = !canExport();
    });
  });
  const volumeControl = document.querySelector<HTMLDivElement>(".volume-control")!;
  const volumeButton = document.getElementById("volume-button") as HTMLButtonElement;
  const volumePopover = document.getElementById("volume-popover") as HTMLDivElement;
  const volumeInput = document.getElementById("volume-input") as HTMLInputElement;
  const closeVolume = () => { volumePopover.hidden = true; volumeButton.setAttribute("aria-expanded", "false"); };
  volumeButton.addEventListener("click", () => {
    volumePopover.hidden = !volumePopover.hidden;
    volumeButton.setAttribute("aria-expanded", String(!volumePopover.hidden));
    if (!volumePopover.hidden) volumeInput.focus({ preventScroll: true });
  });
  volumeControl.addEventListener("focusout", event => {
    if (!volumeControl.contains(event.relatedTarget as Node | null)) closeVolume();
  });
  volumeControl.addEventListener("keydown", event => { if (event.key === "Escape") { closeVolume(); volumeButton.focus({ preventScroll: true }); } });
  volumeInput.addEventListener("input", () => {
    state.volume = Number(volumeInput.value) / 100;
    player.setVolume(state.volume);
    const label = `Volume ${volumeInput.value}%`;
    volumeButton.setAttribute("aria-label", label);
    volumeButton.title = label;
    document.getElementById("volume-icon")!.innerHTML = volumeIcon(state.volume);
  });
  volumeInput.addEventListener("change", () => savePreferences({ volume: state.volume }));
  const tempoInput = document.getElementById("tempo-input") as HTMLInputElement;
  const tempoReset = document.getElementById("tempo-reset") as HTMLButtonElement;
  const tempoDown = document.querySelector<HTMLButtonElement>("#tempo-down")!;
  const tempoUp = document.querySelector<HTMLButtonElement>("#tempo-up")!;
  const readTempo = () => {
    const value = tempoInput.value.trim();
    return /^\d+(?:[.,]\d*)?$/.test(value) ? Number(value.replace(",", ".")) : NaN;
  };
  const applyTempo = (bpm: number, updateField = true) => {
    state.targetBpm = bpm === state.sourceBpm ? bpm : Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
    if (updateField) tempoInput.value = formatBpm(state.targetBpm);
    player.setPlaybackRate(tempoRate(state.targetBpm, state.sourceBpm));
    tempoReset.disabled = !canResetTempo();
    tempoDown.disabled = !canStepTempo(-1);
    tempoUp.disabled = !canStepTempo(1);
  };
  tempoInput.addEventListener("input", () => {
    const bpm = readTempo();
    if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) return;
    applyTempo(bpm, false);
  });
  const stepTempo = (direction: -1 | 1) => {
    if (canStepTempo(direction)) applyTempo(state.targetBpm + direction);
  };
  const commitTempo = () => {
    if (tempoInput.value === formatBpm(state.targetBpm)) return;
    const bpm = readTempo();
    applyTempo(Number.isFinite(bpm) ? bpm : state.targetBpm);
  };
  tempoDown.addEventListener("click", () => stepTempo(-1));
  tempoUp.addEventListener("click", () => stepTempo(1));
  tempoInput.addEventListener("change", commitTempo);
  tempoInput.addEventListener("keydown", event => {
    if (event.key === "Enter") commitTempo();
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      stepTempo(event.key === "ArrowUp" ? 1 : -1);
    }
  });
  tempoReset.addEventListener("click", () => {
    applyTempo(state.sourceBpm);
    tempoInput.focus({ preventScroll: true });
  });
  const seekInput = document.getElementById("seek-input") as HTMLInputElement;
  seekInput.addEventListener("pointerdown", () => { seekDragging = true; });
  seekInput.addEventListener("pointerup", () => { seekDragging = false; });
  seekInput.addEventListener("blur", () => { seekDragging = false; });
  seekInput.addEventListener("input", () => {
    const time = Number(seekInput.value);
    state.startTime = time;
    if (state.isPlaying || state.isPaused) player.seek(time);
    document.getElementById("seek-current")!.textContent = formatTime(time);
    pianoRoll?.invalidate();
  });
  const midiInput = document.getElementById("midi-input") as HTMLInputElement;
  midiInput.addEventListener("change", () => {
    const file = midiInput.files?.[0];
    midiInput.value = "";
    if (file) void importMidi(file);
  });
  bindTrackSelection(root, index => {
    const assignment = state.assignments[index];
    assignment.selected = !isTrackSelected(assignment);
    player.updateAssignments(state.assignments);
    render();
  });
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[data-action], select[data-action]").forEach((control) => {
    control.addEventListener("change", () => {
      const index = Number(control.dataset.track);
      const action = control.dataset.action;
      if (action === "modify") {
        if ((control as HTMLInputElement).checked) checkedTracks.add(index);
        else checkedTracks.delete(index);
        render();
        return;
      }
      const assignment = state.assignments[index];
      if (action === "preset") assignment.preset = Number(control.value);
      player.updateAssignments(state.assignments);
      render();
    });
  });
  root.querySelectorAll<HTMLButtonElement>('button[data-action="edit"]').forEach(button => {
    button.addEventListener("click", () => openTrackMenu(button, Number(button.dataset.track)));
  });
  document.getElementById("play-button")!.addEventListener("click", () => void play());
  // document.getElementById("deselect-all-button")!.addEventListener("click", deselectAllTracks);
  document.getElementById("merge-button")!.addEventListener("click", mergeTracks);
  // document.getElementById("transpose-checked-button")!.addEventListener("click", transposeCheckedTracks);
  document.getElementById("delete-tracks-button")!.addEventListener("click", deleteCheckedTracks);
  document.getElementById("undo-edit-button")!.addEventListener("click", undoEdit);
  document.getElementById("export-button")!.addEventListener("click", exportMidi);
  document.getElementById("stop-button")!.addEventListener("click", () => {
    resetPlayback();
    setMessage("Playback stopped.");
    render();
  });
}

function openTrackMenu(button: HTMLButtonElement, index: number): void {
  const parsed = state.parsedMidi!;
  const track = parsed.midi.tracks[index];
  const assignment = state.assignments[index];
  const summary = parsed.summaries.find(summary => summary.index === index)!;
  const menu = document.createElement("div");
  menu.className = "track-edit-menu";
  menu.setAttribute("popover", "auto");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Edit ${summary.name}`);
  const actions = [
    { label: assignment.autoTranspose ? "Undo transpose" : "Transpose to range", enabled: assignment.autoTranspose || trackNeedsTranspose(summary, assignment), run: () => {
      assignment.autoTranspose = !assignment.autoTranspose;
      void refreshTranspose();
    } },
    { label: assignment.unstrummedNotes ? "Undo strum" : "Strum chords\u2026", enabled: Boolean(assignment.unstrummedNotes) || hasChords(track), run: () => {
      if (!assignment.unstrummedNotes) { openStrumDialog(index); return; }
      resetPlayback();
      undoStrum(track, assignment);
      state.parsedMidi = { midi: parsed.midi, summaries: summarizeMidi(parsed.midi) };
      setMessage("Undid strum.");
      render();
    } },
    { label: "Split drumset\u2026", enabled: Boolean(getDrumSplit(track)), run: () => splitDrumTrack(index) },
    ...[1, -1].map(direction => ({
      label: direction === 1 ? "Octave up" : "Octave down",
      enabled: octaveAllowed(track, assignment, direction),
      run: () => {
        resetPlayback();
        shiftOctave(track, assignment, direction);
        state.parsedMidi = { midi: parsed.midi, summaries: summarizeMidi(parsed.midi) };
        render();
      },
    })),
  ];
  for (const action of actions) {
    const item = document.createElement("button");
    item.type = "button";
    item.role = "menuitem";
    const recommended = getDrumSplit(track) ? action.label.startsWith("Split drumset") :
      !assignment.autoTranspose && trackNeedsTranspose(summary, assignment) && action.label === "Transpose to range";
    item.textContent = action.label;
    if (recommended) {
      item.classList.add("suggested-action");
      const hint = document.createElement("span");
      hint.className = "menu-hint";
      hint.textContent = "Suggested";
      item.append(hint);
    }
    item.disabled = !action.enabled;
    item.addEventListener("click", () => { menu.hidePopover(); action.run(); });
    menu.append(item);
  }
  menu.addEventListener("keydown", event => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const position = items.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
        (position + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  });
  menu.addEventListener("toggle", event => {
    if ((event as ToggleEvent).newState === "closed") {
      button.setAttribute("aria-expanded", "false");
      menu.remove();
      if (button.isConnected) button.focus();
    }
  });
  document.body.append(menu);
  menu.showPopover();
  const rect = button.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
  button.setAttribute("aria-expanded", "true");
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function openStrumDialog(index: number): void {
  const parsed = state.parsedMidi!;
  const result = strumTrack(parsed.midi, index, tempoRate(state.targetBpm, state.sourceBpm));
  const dialog = document.createElement("dialog");
  dialog.className = "track-edit-dialog";
  dialog.setAttribute("aria-labelledby", "strum-title");
  dialog.innerHTML = `<h2 id="strum-title">Strum chords</h2>
    <p>${result.changed} chords, low to high, with 125 ms between notes at the current tempo.</p>
    <p>${result.removed} notes removed to fit before the next chord or note ending.</p>
    <div class="dialog-actions"><button class="secondary" data-strum="cancel">Cancel</button><button data-strum="apply">Apply</button></div>`;
  dialog.querySelector('[data-strum="apply"]')!.addEventListener("click", () => {
    state.assignments[index].unstrummedNotes = parsed.midi.tracks[index].notes.map(
      ({ midi, ticks, durationTicks, velocity, noteOffVelocity }) => ({ midi, ticks, durationTicks, velocity, noteOffVelocity }),
    );
    resetPlayback();
    state.parsedMidi = { midi: result.midi, summaries: summarizeMidi(result.midi) };
    setMessage(`Strummed ${result.changed} chords; removed ${result.removed} notes.`);
    dialog.close();
    render();
  });
  dialog.querySelector('[data-strum="cancel"]')!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function setHoveredTrack(index: number | null): void {
  hoveredTrack = index;
  highlightTrackRow();
}

function highlightTrackRow(): void {
  root.querySelectorAll<HTMLTableRowElement>('tr[data-action="selected"]').forEach(row => {
    row.classList.toggle("piano-note-highlighted", Number(row.dataset.track) === hoveredTrack);
  });
}

async function refreshTranspose(): Promise<void> {
  if (!state.isPlaying && !state.isPaused) { render(); return; }
  const ticket = generation;
  const session = player;
  const time = session.currentTime;
  const paused = state.isPaused;
  session.pause();
  state.isPreparing = true;
  render();
  try {
    const audible = Object.fromEntries(Object.entries(state.assignments).map(([key, a]) => [key, { ...a, selected: true }]));
    const bytes = createConstrainedMidi(state.parsedMidi!.midi, {
      assignments: audible, ...PREVIEW_RULES, autoTranspose: false,
    });
    await session.play(bytes, state.filename!, state.assignments, time, paused);
  } catch (error) {
    if (ticket !== generation) return;
    resetPlayback();
    setMessage(errorMessage(error), true);
    render();
  } finally {
    if (ticket === generation) { state.isPreparing = false; render(); }
  }
}

function canPreview(): boolean {
  return Boolean(state.parsedMidi?.summaries.length && (state.isPlaying || Object.values(state.assignments).some(isTrackSelected)) && !state.isPreparing && !state.isImporting);
}
function renderRangeEndpoint(note: number, assignment: TrackAssignment, range: { minNote: number; maxNote: number }): string {
  const { label, className, message } = rangeEndpoint(note, assignment, false, range);
  if (!className) return escapeHtml(label);
  return `<strong class="${className}" tabindex="0" title="${escapeHtml(message)}" aria-label="${escapeHtml(message)}">${escapeHtml(label)}</strong>`;
}
function playbackTime(): number {
  return state.isPlaying || state.isPaused ? player.currentTime : state.startTime;
}
function updatePlaybackUi(): void {
  const input = document.getElementById("seek-input") as HTMLInputElement | null;
  const current = document.getElementById("seek-current");
  const total = document.getElementById("seek-total");
  const duration = state.parsedMidi?.midi.duration ?? 0;
  const time = Math.max(0, Math.min(playbackTime(), duration));
  if (input && !seekDragging) {
    const previous = input.value;
    input.value = String(time);
    if (input.value !== previous) updateMaterialSlider(input);
  }
  if (input) input.title = `${formatTime(time)} / ${formatTime(duration)}`;
  if (current) current.textContent = formatTime(time);
  if (total) total.textContent = formatTime(duration);
  playbackUiFrame = requestAnimationFrame(updatePlaybackUi);
}
function renderTrackStatus(status: TrackStatus): string {
  const icon = status.level === "healthy" ? "statusHealthy" : status.level === "caution" ? "statusCaution" : "statusWarning";
  const label = status.level === "healthy" ? "Healthy track" : status.level === "caution" ? "Track needs attention" : "Track has severe issues";
  const detail = escapeHtml(status.tooltip);
  return `<span class="track-status status-${status.level}" tabindex="0" title="${detail}" aria-label="${label}. ${detail}">${interfaceIcon(icon)}<span class="track-status-detail" aria-hidden="true">${detail}</span></span>`;
}
function selectedTrackCount(): number {
  return Object.values(state.assignments).filter(isTrackSelected).length;
}
function checkedTrackCount(): number {
  return [...checkedTracks].filter(index => state.assignments[index]).length;
}
const INTERFACE_ICON_PATHS = {
  folder: "M2 6.25A2.25 2.25 0 0 1 4.25 4h3.956a2.25 2.25 0 0 1 1.438.52l2.381 1.98h5.725A2.25 2.25 0 0 1 20 8.75v.752H6.422a2.25 2.25 0 0 0-2.183 1.705l-1.923 7.7c.043-.171 0 .005 0 0a2.24 2.24 0 0 1-.32-1.158L2 6.25Zm1.745 13.129A.5.5 0 0 0 4.23 20h14.24a1.75 1.75 0 0 0 1.698-1.326l1.763-7.05a.5.5 0 0 0-.485-.622H6.422a.75.75 0 0 0-.728.568L3.745 19.38Z",
  save: "M6.75 3h-1A2.75 2.75 0 0 0 3 5.75v12.5A2.75 2.75 0 0 0 5.75 21H6v-6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 15v6h.25A2.75 2.75 0 0 0 21 18.25V8.286a3.25 3.25 0 0 0-.952-2.299l-2.035-2.035A3.25 3.25 0 0 0 15.75 3v4.5a2.25 2.25 0 0 1-2.25 2.25H9A2.25 2.25 0 0 1 6.75 7.5V3Zm7.5 0v4.5a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75V3h6ZM16.5 21v-6a.75.75 0 0 0-.75-.75h-7.5a.75.75 0 0 0-.75.75v6h9Z",
  play: "M5 5.274c0-1.707 1.826-2.792 3.325-1.977l12.362 6.726c1.566.853 1.566 3.101 0 3.953L8.325 20.702C6.826 21.518 5 20.432 5 18.726V5.274Z",
  pause: "M5.746 3a1.75 1.75 0 0 0-1.75 1.75v14.5c0 .966.784 1.75 1.75 1.75h3.5a1.75 1.75 0 0 0 1.75-1.75V4.75A1.75 1.75 0 0 0 9.246 3h-3.5ZM14.746 3a1.75 1.75 0 0 0-1.75 1.75v14.5c0 .966.784 1.75 1.75 1.75h3.5a1.75 1.75 0 0 0 1.75-1.75V4.75A1.75 1.75 0 0 0 18.246 3h-3.5Z",
  stop: "M4.75 3A1.75 1.75 0 0 0 3 4.75v14.5c0 .966.784 1.75 1.75 1.75h14.5A1.75 1.75 0 0 0 21 19.25V4.75A1.75 1.75 0 0 0 19.25 3H4.75Z",
  delete: "M9.75 3A2.75 2.75 0 0 0 7 5.75V6H4.75a.75.75 0 0 0 0 1.5h.3l.83 11.2A2.5 2.5 0 0 0 8.37 21h7.26a2.5 2.5 0 0 0 2.49-2.3l.83-11.2h.3a.75.75 0 0 0 0-1.5H17v-.25A2.75 2.75 0 0 0 14.25 3h-4.5ZM15.5 6h-7v-.25A1.25 1.25 0 0 1 9.75 4.5h4.5a1.25 1.25 0 0 1 1.25 1.25V6Z",
  statusHealthy: "M12 2c5.523 0 10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2Zm3.22 6.97-4.47 4.47-1.97-1.97a.75.75 0 0 0-1.06 1.06l2.5 2.5a.75.75 0 0 0 1.06 0l5-5a.75.75 0 1 0-1.06-1.06Z",
  statusCaution: "M12 2c5.523 0 10 4.478 10 10s-4.477 10-10 10S2 17.522 2 12 6.477 2 12 2Zm0 13.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm0-8.75A2.75 2.75 0 0 0 9.25 9.5a.75.75 0 0 0 1.493.102l.007-.102a1.25 1.25 0 1 1 2.5 0c0 .539-.135.805-.645 1.332l-.135.138c-.878.878-1.22 1.447-1.22 2.53a.75.75 0 0 0 1.5 0c0-.539.135-.805.645-1.332l.135-.138c.878-.878 1.22-1.447 1.22-2.53A2.75 2.75 0 0 0 12 6.75Z",
  statusWarning: "M12 2c5.523 0 10 4.478 10 10s-4.477 10-10 10S2 17.522 2 12 6.477 2 12 2Zm.002 13.004a.999.999 0 1 0 0 1.997.999.999 0 0 0 0-1.997ZM12 7a1 1 0 0 0-.993.884L11 8l.002 5.001.007.117a1 1 0 0 0 1.986 0l.007-.117L13 8l-.007-.117A1 1 0 0 0 12 7Z",
} as const;
const MATERIAL_ICONS: Record<keyof typeof INTERFACE_ICON_PATHS, string> = {
  folder: "folder_open",
  save: "download",
  play: "play_arrow",
  pause: "pause",
  stop: "stop",
  delete: "delete",
  statusHealthy: "check_circle",
  statusCaution: "help",
  statusWarning: "warning",
};
function interfaceIcon(name: keyof typeof INTERFACE_ICON_PATHS): string {
  const icon = `<svg width="20" height="20" fill="none" viewBox="0 0 24 24" aria-hidden="true"><path d="${INTERFACE_ICON_PATHS[name]}" fill="currentColor" /></svg>`;
  return materialIcon(MATERIAL_ICONS[name], icon);
}
function volumeIcon(volume: number): string {
  const path = volume <= 0
    ? "M15 4.25c0-1.079-1.274-1.65-2.08-.934L8.427 7.309a.75.75 0 0 1-.498.19H4.25A2.25 2.25 0 0 0 2 9.749v4.497a2.25 2.25 0 0 0 2.25 2.25h3.68a.75.75 0 0 1 .498.19l4.491 3.994c.806.716 2.081.144 2.081-.934V4.25ZM16.22 9.22a.75.75 0 0 1 1.06 0L19 10.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L20.06 12l1.72 1.72a.75.75 0 1 1-1.06 1.06L19 13.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L17.94 12l-1.72-1.72a.75.75 0 0 1 0-1.06Z"
    : volume < .15
      ? "M14.704 3.441c.191.226.296.512.296.808V19.75a1.25 1.25 0 0 1-2.058.954l-4.967-4.206H4.25A2.25 2.25 0 0 1 2 14.248v-4.5a2.25 2.25 0 0 1 2.25-2.25h3.725l4.968-4.204a1.25 1.25 0 0 1 1.761.147Z"
      : volume < .5
        ? "M14.704 3.442c.191.226.296.512.296.808v15.502a1.25 1.25 0 0 1-2.058.954L7.975 16.5H4.25A2.25 2.25 0 0 1 2 14.25v-4.5A2.25 2.25 0 0 1 4.25 7.5h3.725l4.968-4.204a1.25 1.25 0 0 1 1.761.147Zm2.4 5.198a.75.75 0 0 1 1.03.25c.574.94.862 1.992.862 3.14 0 1.149-.288 2.201-.862 3.141a.75.75 0 1 1-1.28-.781c.428-.702.642-1.483.642-2.36 0-.876-.214-1.657-.642-2.359a.75.75 0 0 1 .25-1.03Z"
        : "M15 4.25v15.496c0 1.078-1.274 1.65-2.08.934l-4.492-3.994a.75.75 0 0 0-.498-.19H4.25A2.25 2.25 0 0 1 2 14.247V9.75A2.25 2.25 0 0 1 4.25 7.5h3.68a.75.75 0 0 0 .498-.19l4.491-3.993C13.726 2.599 15 3.17 15 4.25Zm3.992 1.647a.75.75 0 0 1 1.049.157A9.959 9.959 0 0 1 22 12a9.96 9.96 0 0 1-1.96 5.946.75.75 0 0 1-1.205-.892A8.459 8.459 0 0 0 20.5 12a8.459 8.459 0 0 0-1.665-5.054.75.75 0 0 1 .157-1.049ZM17.143 8.37a.75.75 0 0 1 1.017.303c.536.99.84 2.125.84 3.328a6.973 6.973 0 0 1-.84 3.328.75.75 0 0 1-1.32-.714c.42-.777.66-1.666.66-2.614s-.24-1.837-.66-2.614a.75.75 0 0 1 .303-1.017Z";
  const icon = `<svg width="20" height="20" fill="none" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" fill="currentColor" /></svg>`;
  return materialIcon(volume <= 0 ? "volume_off" : volume < .15 ? "volume_mute" : volume < .5 ? "volume_down" : "volume_up", icon);
}
function deselectAllTracks(): void {
  for (const assignment of Object.values(state.assignments)) assignment.selected = false;
  player.updateAssignments(state.assignments);
  render();
}
function transposeCheckedTracks(): void {
  if (!state.parsedMidi || state.isPreparing || state.isImporting) return;
  const updates = state.parsedMidi.summaries.filter(summary => {
    const assignment = state.assignments[summary.index];
    return checkedTracks.has(summary.index) && !assignment.autoTranspose && trackNeedsTranspose(summary, assignment);
  });
  if (!updates.length) {
    setMessage("No checked tracks need transposing.");
    render();
    return;
  }
  for (const { index } of updates) state.assignments[index].autoTranspose = true;
  setMessage(`Transposed ${updates.length === 1 ? "one track" : `${updates.length} tracks`}.`);
  void refreshTranspose();
}

function mergeTracks(): void {
  if (!state.parsedMidi || checkedTrackCount() < 2) return;
  pianoRoll?.highlightTrack(null);
  try {
    const snapshot = snapshotMergeState(state.parsedMidi.midi, state.assignments);
    const result = mergeSelectedTracks(state.parsedMidi, state.assignments, checkedTracks);
    resetPlayback();
    editHistory.push({ snapshot, checkedTracks: [...checkedTracks], action: "merge" });
    state.parsedMidi = result.parsed;
    state.assignments = result.assignments;
    checkedTracks.clear();
    checkedTracks.add(result.mergedIndex);
    setMessage(`Merged ${result.count} tracks.`);
  } catch (error) { setMessage(errorMessage(error), true); }
  render();
}
function deleteCheckedTracks(): void {
  if (!state.parsedMidi || !checkedTrackCount()) return;
  pianoRoll?.highlightTrack(null);
  const snapshot = snapshotMergeState(state.parsedMidi.midi, state.assignments);
  const checked = [...checkedTracks];
  const preservePlayback = (state.isPlaying || state.isPaused)
    && checked.every(index => !isTrackSelected(state.assignments[index]));
  const result = deleteTracks(state.parsedMidi, state.assignments, checkedTracks);
  if (preservePlayback) {
    player.remapTracks(result.indexMap);
    player.updateAssignments(result.assignments);
  } else {
    resetPlayback();
  }
  editHistory.push({ snapshot, checkedTracks: checked, action: "deletion" });
  state.parsedMidi = result.parsed;
  state.assignments = result.assignments;
  checkedTracks.clear();
  setMessage(`Deleted ${result.count} ${result.count === 1 ? "track" : "tracks"}.`);
  render();
}
function splitDrumTrack(index: number): void {
  if (!state.parsedMidi || state.isPreparing || state.isImporting) return;
  const split = getDrumSplit(state.parsedMidi.midi.tracks[index]);
  if (!split) return;
  const counts = split.parts.map(part => `${part.name} (${part.notes.length} hits)`).join(" and ");
  const omitted = split.dropped ? ` This removes ${split.dropped} other percussion hits.` : "";
  const action = split.parts.length === 1 ? "Keep only" : "Split into";
  const dialog = document.createElement("dialog");
  dialog.className = "track-edit-dialog";
  dialog.setAttribute("aria-labelledby", "split-title");
  dialog.innerHTML = `<h2 id="split-title">Split drumset</h2>
    <p>${action} ${counts}.</p>
    <p>${split.dropped ? `${split.dropped} other percussion hits will be removed.` : "All hits are retained."} Each part uses C4 with its matching drum preset.</p>
    <div class="dialog-actions"><button class="secondary" data-split="cancel">Cancel</button><button data-split="apply">Apply</button></div>`;
  dialog.querySelector('[data-split="cancel"]')!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector('[data-split="apply"]')!.addEventListener("click", () => {
    if (!state.parsedMidi) return;
    dialog.close();
    try {
      const result = splitDrums(state.parsedMidi, state.assignments, index);
      resetPlayback();
      pianoRoll?.highlightTrack(null);
      state.parsedMidi = result.parsed;
      state.assignments = result.assignments;
      checkedTracks.clear();
      setMessage(`Created ${counts}.${omitted}`);
    } catch (error) { setMessage(errorMessage(error), true); }
    render();
  });
  document.body.append(dialog);
  dialog.showModal();
}
function undoEdit(): void {
  const entry = editHistory.pop();
  if (!entry) return;
  resetPlayback();
  const { snapshot } = entry;
  state.parsedMidi = { midi: snapshot.midi, summaries: summarizeMidi(snapshot.midi) };
  state.assignments = snapshot.assignments;
  checkedTracks.clear();
  for (const index of entry.checkedTracks) checkedTracks.add(index);
  setMessage(`Undid ${entry.action}.`);
  render();
}
function canExport(): boolean {
  const assignments = Object.values(state.assignments);
  return Boolean(state.filename && state.parsedMidi && assignments.length && (state.exportOptions.keepUnselectedTracks || assignments.some(isTrackSelected)) && !state.isPreparing && !state.isImporting);
}
function exportMidi(): void {
  if (!canExport()) return;
  try {
    const exported = createMidiExport(state.parsedMidi!.midi, state.filename!, state.assignments, tempoRate(state.targetBpm, state.sourceBpm), {
      includeUnselected: state.exportOptions.keepUnselectedTracks,
      trimEmptySpace: state.exportOptions.trimEmptySpace,
    });
    const url = URL.createObjectURL(new Blob([exported.bytes as BlobPart], { type: "audio/midi" }));
    const link = document.createElement("a");
    link.href = url; link.download = exported.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setMessage(`Exported ${exported.filename}.`);
  } catch (error) { setMessage(errorMessage(error), true); }
  render();
}

function setMessage(message: string, isError = false): void {
  state.message = message;
  state.messageIsError = isError;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Could not load preview."; }
function canResetTempo(): boolean { return Boolean(state.parsedMidi && state.targetBpm !== state.sourceBpm); }
function canStepTempo(direction: -1 | 1): boolean {
  return Boolean(state.parsedMidi && (direction < 0 ? state.targetBpm > MIN_BPM : state.targetBpm < MAX_BPM));
}
function formatBpm(bpm: number): string { return Number(bpm.toFixed(2)).toString(); }
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

window.addEventListener("pagehide", () => player.dispose());
window.addEventListener("pagehide", () => pianoRoll?.dispose());
render();
playbackUiFrame = requestAnimationFrame(updatePlaybackUi);
window.addEventListener("pagehide", () => cancelAnimationFrame(playbackUiFrame));
