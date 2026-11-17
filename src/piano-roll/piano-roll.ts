import "./piano-roll.css";
import type { ParsedMidi } from "../midi-analysis";
import type { TrackAssignment } from "../types";
import { adaptNote } from "../auto-transpose";
import { FFXIV_MIN_NOTE, noteName } from "../ffxiv";
import { isTrackSelected, shouldAutoTranspose } from "../composition";
import { createFollowController } from "./follow";
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from "../preferences";
import { trackColor, DIMMED_NOTE_OPACITY } from "../track-presentation";
import { formatTime } from "../time";

type Snapshot = {
  parsed: ParsedMidi | null;
  assignments: Record<number, TrackAssignment>;
  time: number;
  playing: boolean;
  autoTranspose: boolean;
};
const KEYBOARD = 60;
const RULER = 24;
const MIN_LABEL_FONT = 8;
type Span = [left: number, right: number];
type NoteLabel = { x: number; y: number; width: number; pitch: number; dimmed: boolean };

function labelStart(left: number, right: number, required: number, covered: Span[]): number | undefined {
  for (const [start, end] of covered) {
    if (Math.min(start, right) - left >= required) return left;
    left = Math.max(left, end);
    if (right - left < required) return;
  }
  if (right - left >= required) return left;
}

function coverSpan(covered: Span[], left: number, right: number): void {
  const first = covered.findIndex(([, end]) => end >= left);
  if (first === -1) {
    covered.push([left, right]);
    return;
  }
  let next = first;
  while (next < covered.length && covered[next][0] <= right) {
    left = Math.min(left, covered[next][0]);
    right = Math.max(right, covered[next][1]);
    next++;
  }
  covered.splice(first, next - first, [left, right]);
}

const DEFAULT_TIME_ZOOM = DEFAULT_PREFERENCES.timeZoom;
const DEFAULT_PITCH_ZOOM = DEFAULT_PREFERENCES.pitchZoom;
const defaultColors = {
  background: "#2d3d45",
  darkLane: "#28363e",
  lightLane: "#33454e",
  outsideRange: "#a6545420",
  octaveLine: "#64747c",
  pitchLine: "#26363e",
  darkKey: "#33383c",
  lightKey: "#c8cecf",
  keyText: "#202b30",
  ruler: "#1e2b32",
  rulerText: "#ced9de",
  playhead: "#f5d86f",
  dimmedNoteText: "#dfd8e4",
};

export function createPianoRoll(
  read: () => Snapshot,
  seek?: (time: number) => void,
  hoverTrack?: (track: number | null) => void,
  colors = defaultColors,
) {
  const preferences = loadPreferences();
  const initialTimeZoom = preferences.timeZoom;
  const initialPitchZoom = preferences.pitchZoom;
  const element = document.createElement("section");
  element.className = "piano-roll";
  element.innerHTML = `<div class="roll-toolbar">
    <h2>Piano roll</h2>
    <label><span>Time zoom</span> <input aria-label="Time zoom" type="range" min="25" max="250" value="${initialTimeZoom}"></label>
    <label><span>Pitch zoom</span> <input aria-label="Pitch zoom" type="range" min="8" max="26" value="${initialPitchZoom}"></label>
    <button class="secondary zoom-reset" type="button" aria-label="Reset zoom" title="Reset zoom" ${initialTimeZoom === DEFAULT_TIME_ZOOM && initialPitchZoom === DEFAULT_PITCH_ZOOM ? "disabled" : ""}><svg width="18" height="18" fill="none" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.207 2.543a1 1 0 0 1 0 1.414L5.414 5.75h7.836a8 8 0 1 1-8 8 1 1 0 1 1 2 0 6 6 0 1 0 6-6H5.414l1.793 1.793a1 1 0 0 1-1.414 1.414l-3.5-3.5a1 1 0 0 1 0-1.414l3.5-3.5a1 1 0 0 1 1.414 0Z" fill="currentColor" /></svg></button>
    <label><input type="checkbox" checked> <span>Follow playback</span></label><output class="roll-clock">0:00</output>
    </div><div class="roll-viewport" tabindex="0" aria-label="MIDI piano roll. Scroll horizontally for time and vertically for pitch.">
      <div class="roll-space"></div><canvas aria-label="Layered MIDI notes"></canvas>
    </div>`;
  const viewport = element.querySelector<HTMLDivElement>(".roll-viewport")!;
  const spacer = element.querySelector<HTMLDivElement>(".roll-space")!;
  const canvas = element.querySelector("canvas")!;
  const ctx = canvas.getContext("2d")!;
  const labelMetrics = new Map<string, TextMetrics>();
  const sliders = element.querySelectorAll<HTMLInputElement>('input[type="range"]');
  const resetZoom = element.querySelector<HTMLButtonElement>(".zoom-reset")!;
  const follow = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const clock = element.querySelector("output")!;
  const camera = createFollowController();
  let expectedLeft = viewport.scrollLeft, expectedTop = viewport.scrollTop;
  const rememberScroll = () => { expectedLeft = viewport.scrollLeft; expectedTop = viewport.scrollTop; };
  let dragging = false;
  const endDrag = () => {
    if (dragging) { dragging = false; camera.drag(false, performance.now()); }
  };
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  window.addEventListener("blur", endDrag);
  let lastTranspose: boolean | undefined;
  let pointer: { x:number; y:number } | null = null;
  let hits: { x:number; y:number; width:number; text:string; track:number }[] = [];
  let hoveredTrack: number | null = null;
  function setHoveredTrack(track: number | null) {
    if (hoveredTrack === track) return;
    hoveredTrack = track;
    hoverTrack?.(track);
  }
  function updateHover() {
    canvas.title = "";
    if (!pointer || pointer.x < KEYBOARD || pointer.y < RULER) { setHoveredTrack(null); return; }
    for (let i = hits.length - 1; i >= 0; i--) {
      const hit = hits[i];
      if (pointer.x >= hit.x && pointer.x <= hit.x + hit.width && pointer.y >= hit.y && pointer.y < hit.y + row) {
        canvas.title = hit.text;
        setHoveredTrack(hit.track);
        break;
      }
    }
    if (!canvas.title) setHoveredTrack(null);
  }
  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x:event.clientX - rect.left, y:event.clientY - rect.top };
    updateHover();
  });
  canvas.addEventListener("pointerleave", () => { pointer = null; canvas.title = ""; setHoveredTrack(null); });
  canvas.addEventListener("click", (event) => {
    if (!source || !seek || event.button !== 0) return;
    const x = event.clientX - canvas.getBoundingClientRect().left;
    if (x < KEYBOARD) return;
    seek(Math.max(0, Math.min(source.midi.duration, (x - KEYBOARD + viewport.scrollLeft) / scale)));
    dirty = true;
  });
  let source: ParsedMidi | null | undefined;
  let notes: { pitch:number; start:number; end:number; track:number; name:string; color:string }[] = [];
  let highlightedTrack: number | null = null;
  let scale = initialTimeZoom, row = initialPitchZoom, frame = 0, disposed = false;
  let dirty = true, lastTime = -1, lastAssignments: Record<number, TrackAssignment> | null = null;
  let width = 0, height = 0;
  const dimensions = () => {
    spacer.style.width = `${Math.max(viewport.clientWidth, KEYBOARD + ((source?.midi.duration ?? 15) + 3) * scale)}px`;
    spacer.style.height = `${128 * row + RULER}px`;
    dirty = true;
  };
  const updateResetState = () => {
    resetZoom.disabled = Number(sliders[0].value) === DEFAULT_TIME_ZOOM && Number(sliders[1].value) === DEFAULT_PITCH_ZOOM;
  };
  const updateTimeZoom = () => {
    camera.manual(performance.now());
    const time = viewport.scrollLeft / scale;
    scale = Number(sliders[0].value); dimensions(); viewport.scrollLeft = time * scale;
    rememberScroll();
    updateResetState();
  };
  const updatePitchZoom = () => {
    camera.manual(performance.now());
    const pitch = viewport.scrollTop / row;
    row = Number(sliders[1].value); dimensions(); viewport.scrollTop = pitch * row;
    rememberScroll();
    updateResetState();
  };
  sliders[0].oninput = updateTimeZoom;
  sliders[1].oninput = updatePitchZoom;
  sliders[0].onchange = () => savePreferences({ timeZoom: scale });
  sliders[1].onchange = () => savePreferences({ pitchZoom: row });
  resetZoom.onclick = () => {
    sliders[0].value = String(DEFAULT_TIME_ZOOM);
    sliders[1].value = String(DEFAULT_PITCH_ZOOM);
    updateTimeZoom();
    updatePitchZoom();
    savePreferences({ timeZoom: DEFAULT_TIME_ZOOM, pitchZoom: DEFAULT_PITCH_ZOOM });
  };
  viewport.addEventListener("wheel", () => camera.manual(performance.now()), { passive: true });
  viewport.addEventListener("keydown", event => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) camera.manual(performance.now());
  });
  viewport.addEventListener("pointerdown", event => {
    if (event.target !== canvas || event.pointerType === "touch") {
      dragging = true; camera.drag(true, performance.now());
    }
  });
  viewport.addEventListener("scroll", () => {
    if (viewport.scrollLeft !== expectedLeft || viewport.scrollTop !== expectedTop) camera.manual(performance.now());
    rememberScroll();
    dirty = true;
  });
  const resize = new ResizeObserver(() => { dimensions(); });
  resize.observe(viewport);

  function drawNoteLabels(labels: NoteLabel[], viewportWidth: number, viewportHeight: number) {
    const coveredByPitch = new Map<number, Span[]>();
    const preferredSize = Math.min(11, row);
    const sizes = preferredSize === MIN_LABEL_FONT ? [MIN_LABEL_FONT] : [preferredSize, MIN_LABEL_FONT];
    ctx.textBaseline = "alphabetic";
    for (let index = labels.length - 1; index >= 0; index--) {
      const { x, y, width, pitch, dimmed } = labels[index];
      const left = Math.max(KEYBOARD, x), right = Math.min(viewportWidth, x + width);
      if (left >= right) continue;
      let covered = coveredByPitch.get(pitch);
      if (!covered) coveredByPitch.set(pitch, covered = []);
      const text = noteName(pitch);
      const center = y + row / 2;
      for (const size of sizes) {
        const font = `${size}px system-ui`;
        const key = `${size}:${text}`;
        let metrics = labelMetrics.get(key);
        if (!metrics) {
          ctx.font = font;
          metrics = ctx.measureText(text);
          labelMetrics.set(key, metrics);
        }
        const { actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent } = metrics;
        const halfHeight = (ascent + descent) / 2;
        if (halfHeight > (row - 2) / 2 || center - halfHeight < RULER || center + halfHeight > viewportHeight) continue;
        const overhang = Math.max(0, metrics.actualBoundingBoxLeft);
        const padding = size === MIN_LABEL_FONT ? 1 : 2;
        const required = Math.max(metrics.width, metrics.actualBoundingBoxRight + overhang) + padding * 2;
        const start = labelStart(left, right, required, covered);
        if (start === undefined) continue;
        ctx.font = font;
        ctx.fillStyle = dimmed ? colors.dimmedNoteText : "#18342b";
        ctx.fillText(text, start + padding + overhang, center + (ascent - descent) / 2);
        break;
      }
      coverSpan(covered, left, right);
    }
  }

  function draw(snapshot: Snapshot) {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    if (!w || !h) return;
    const ratio = window.devicePixelRatio || 1;
    if (w !== width || h !== height || canvas.width !== Math.round(w * ratio)) {
      width = w; height = h;
      canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const left = viewport.scrollLeft, top = viewport.scrollTop;
    ctx.fillStyle = colors.background; ctx.fillRect(0, 0, w, h);
    ctx.font = "11px system-ui";
    ctx.textBaseline = "middle";
    for (let pitch = 0; pitch < 128; pitch++) {
      const y = RULER + (127 - pitch) * row - top;
      if (y + row < RULER || y > h) continue;
      const black = [1, 3, 6, 8, 10].includes(pitch % 12);
      ctx.fillStyle = black ? colors.darkLane : colors.lightLane;
      ctx.fillRect(KEYBOARD, y, w - KEYBOARD, row);
      if (pitch < 48 || pitch > 84) { ctx.fillStyle = colors.outsideRange; ctx.fillRect(KEYBOARD, y, w - KEYBOARD, row); }
      ctx.fillStyle = pitch % 12 === 0 ? colors.octaveLine : colors.pitchLine;
      ctx.fillRect(KEYBOARD, y + row - 1, w - KEYBOARD, 1);
      ctx.fillStyle = black ? colors.darkKey : colors.lightKey;
      ctx.fillRect(0, y, KEYBOARD - 1, row - 1);
      if (pitch % 12 === 0) { ctx.fillStyle = colors.keyText; ctx.fillText(`C${Math.floor(pitch / 12) - 1}`, 32, y + (row - 1) / 2); }
    }
    const tick = scale < 50 ? 5 : 1;
    for (let sec = Math.floor(left / scale / tick) * tick; sec * scale - left < w; sec += tick) {
      const x = KEYBOARD + sec * scale - left;
      if (x < KEYBOARD) continue;
      ctx.fillStyle = colors.ruler; ctx.fillRect(x, RULER, 1, h);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(KEYBOARD, RULER, w - KEYBOARD, h - RULER); ctx.clip();
    hits = [];
    const labels: NoteLabel[] = [];
    for (const note of notes) {
      const assignment = snapshot.assignments[note.track];
      if (!isTrackSelected(assignment)) continue;
      const original = note.pitch + (assignment?.transpose ?? 0);
      const pitch = shouldAutoTranspose(assignment, snapshot.autoTranspose) ? adaptNote(original) : original;
      const moved = pitch !== original;
      const outOfRange = pitch < 48 || pitch > 84;
      const x = KEYBOARD + note.start * scale - left, y = RULER + (127 - pitch) * row - top;
      const nw = Math.max(2, (note.end - note.start) * scale);
      if (x + nw < KEYBOARD || x > w || y + row < RULER || y > h) continue;
      const active = snapshot.playing && note.start <= snapshot.time && snapshot.time < note.end && !outOfRange;
      ctx.globalAlpha = outOfRange ? DIMMED_NOTE_OPACITY : .8;
      ctx.fillStyle = active ? "#f5fff0" : note.color;
      ctx.fillRect(x, y + 1, nw, row - 2);
      if (moved) {
        ctx.strokeStyle = "#ffdc73";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + .75, y + 1.75, Math.max(.5, nw - 1.5), row - 3.5);
      }
      hits.push({ x, y, width:nw, track:note.track, text: `${note.name}: ${moved ? `${noteName(original)} -> ${noteName(pitch)} (Auto transpose, ${pitch - original > 0 ? "+" : ""}${pitch - original} semitones)` : noteName(pitch)}${outOfRange ? " - outside C3-C6, silent" : ""}` });
      labels.push({ x, y, width: nw, pitch, dimmed: outOfRange });
    }
    ctx.globalAlpha = 1;
    if (highlightedTrack !== null) {
      for (const note of notes) {
        if (note.track !== highlightedTrack) continue;
        const assignment = snapshot.assignments[note.track];
        const included = isTrackSelected(assignment);
        const original = note.pitch + (assignment?.transpose ?? 0);
        const pitch = shouldAutoTranspose(assignment, snapshot.autoTranspose) ? adaptNote(original) : original;
        const x = KEYBOARD + note.start * scale - left, y = RULER + (127 - pitch) * row - top;
        const nw = Math.max(2, (note.end - note.start) * scale);
        if (x + nw < KEYBOARD || x > w || y + row < RULER || y > h) continue;
        ctx.save();
        ctx.globalAlpha = included ? .95 : DIMMED_NOTE_OPACITY;
        ctx.shadowColor = note.color;
        ctx.shadowBlur = included ? 12 : 5;
        ctx.fillStyle = note.color;
        ctx.fillRect(x, y + 1, nw, row - 2);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = included ? 1 : .4;
        ctx.strokeStyle = included ? "#f5fff0" : "#cfd7dc";
        ctx.lineWidth = included ? 2 : 1;
        ctx.strokeRect(x + 1, y + 2, Math.max(0, nw - 2), Math.max(0, row - 4));
        ctx.restore();
        labels.push({ x, y, width: nw, pitch, dimmed: !included });
      }
    }
    drawNoteLabels(labels, w, h);
    const cursor = KEYBOARD + snapshot.time * scale - left;
    ctx.fillStyle = colors.playhead; ctx.fillRect(cursor, RULER, 2, h);
    ctx.restore();
    ctx.fillStyle = colors.ruler; ctx.fillRect(0, 0, w, RULER);
    ctx.fillStyle = colors.rulerText;
    ctx.textBaseline = "alphabetic";
    for (let sec = Math.floor(left / scale / tick) * tick; sec * scale - left < w; sec += tick) {
      const x = KEYBOARD + sec * scale - left;
      if (x >= KEYBOARD) ctx.fillText(sec < 60 ? `${sec}s` : formatTime(sec), x + 4, 16);
    }
    if (!source) { ctx.fillStyle = "#e0e8e9"; ctx.fillText("No MIDI loaded", KEYBOARD + 20, 60); }
    else if (!source.summaries.some(s => isTrackSelected(snapshot.assignments[s.index]))) {
      ctx.fillStyle = "#e0e8e9"; ctx.fillText("No tracks selected — include a track above", KEYBOARD + 20, 60);
    }
    updateHover();
  }

  function loop() {
    if (disposed) return;
    try {
      const snapshot = read();
      if (snapshot.parsed !== source) {
        source = snapshot.parsed;
        camera.reset();
        notes = [];
        source?.summaries.forEach((summary, position) => {
          for (const note of source!.midi.tracks[summary.index].notes) notes.push({ pitch:note.midi, start:note.time, end:note.time + note.duration, track:summary.index, name:summary.name, color:trackColor(position) });
        });
        dimensions(); viewport.scrollLeft = 0;
        const playableBottom = RULER + (128 - FFXIV_MIN_NOTE) * row;
        viewport.scrollTop = Math.max(0, playableBottom + 1.5 * row - viewport.clientHeight);
        rememberScroll();
      }
      const nextLeft = camera.next({ now: performance.now(), playing: snapshot.playing, enabled: follow.checked,
        playhead: snapshot.time * scale, left: viewport.scrollLeft, width: viewport.clientWidth - KEYBOARD,
        maxLeft: Math.max(0, viewport.scrollWidth - viewport.clientWidth) });
      if (nextLeft !== viewport.scrollLeft) {
        viewport.scrollLeft = nextLeft;
        rememberScroll();
        dirty = true;
      }
      const anyTranspose = snapshot.autoTranspose || Object.values(snapshot.assignments).some(a => isTrackSelected(a) && a.autoTranspose);
      if (anyTranspose !== lastTranspose) {
        if (anyTranspose && (viewport.scrollTop + viewport.clientHeight < (127 - 84) * row || viewport.scrollTop > (127 - 48) * row)) {
          viewport.scrollTop = (127 - 87) * row;
          rememberScroll();
        }
        lastTranspose = anyTranspose;
        dirty = true;
      }
      if (snapshot.assignments !== lastAssignments) dirty = true;
      lastAssignments = snapshot.assignments;
      if (dirty || snapshot.time !== lastTime || snapshot.playing) {
        draw(snapshot); dirty = false; lastTime = snapshot.time;
        clock.textContent = `${formatTime(snapshot.time)}/${formatTime(source?.midi.duration ?? 0)}`;
      }
    } catch (error) {
      console.error("Piano roll", error);
      resize.disconnect();
      return;
    }
    frame = requestAnimationFrame(loop);
  }
  frame = requestAnimationFrame(loop);
  return {
    element,
    invalidate() { dirty = true; },
    setColors(palette: typeof defaultColors) { colors = palette; dirty = true; },
    highlightTrack(index: number | null) {
      if (highlightedTrack === index) return;
      highlightedTrack = index;
      dirty = true;
    },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect();
      setHoveredTrack(null);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
      element.remove();
    },
  };
}
