/**
 * Reactive state boundary between the imperative game/replay engine and the
 * Svelte UI.  The engine never touches the DOM: the `UI` / `ReplayLibraryUI` /
 * `ReplayViewerUI` controllers (which keep their old method signatures so
 * `GameClient` / `ReplayPlayer` are untouched) translate calls into writes on
 * these stores, and Svelte renders.  Hot per-frame values are individual
 * stores that the controllers only `.set()` on change, so churn stays minimal.
 */
import { writable } from "svelte/store";
import type { InputMode } from "../../game/input";
import type { Quality } from "../../game/quality";

/* ------------------------------------------------------------------ screen */

export type Screen = "menu" | "connecting" | "hud" | "replayLib" | "replayViewer";
export const screen = writable<Screen>("menu");

/* -------------------------------------------------------------------- menu */

export interface MenuState {
  error: string;
  touch: boolean;
  mode: InputMode;
  showReplays: boolean;
  onCreate: (name: string) => void;
  onJoin: (name: string, code: string) => void;
  onSettings: () => void;
  onReplays: () => void;
}
export const menu = writable<MenuState | null>(null);

/* --------------------------------------------------------- lobby/match-end */

export interface PlayerCard {
  id: number;
  name: string;
  color: string;
  bot: boolean;
  difficulty: number;
  host: boolean;
  wins: number;
  best: boolean;
  removable: boolean;
}

export type Overlay =
  | { kind: "none" }
  | {
      kind: "lobby";
      code: string;
      players: PlayerCard[];
      isHost: boolean;
      canAddBot: boolean;
      botTiers: string[];
      onStart: () => void;
      onAddBot: (difficulty: number) => void;
      onRemoveBot: (id: number) => void;
      onCopyCode: () => void;
    }
  | {
      kind: "matchend";
      winnerName: string;
      players: PlayerCard[];
      isHost: boolean;
      onRematch: () => void;
      onWatchReplay: (() => void) | null;
      onSaveReplayFile: (() => void) | null;
    };
export const overlay = writable<Overlay>({ kind: "none" });

/* ------------------------------------------------------------- HUD scalars */

export interface ScoreRow {
  id: number;
  name: string;
  color: string;
  wins: number;
  dead: boolean;
  disconnected: boolean;
  bot: boolean;
  difficulty: number;
}
export const scores = writable<ScoreRow[]>([]);
export const hudCode = writable("");
/** Lobby "copied!" flash, kept out of the overlay object so a copy click
 *  doesn't rebuild the whole roster. */
export const lobbyCopied = writable(false);

export const damage = writable("");
export const damageColor = writable("rgb(255,162,142)");
export const damageBump = writable(0);
export const ping = writable("");
export const powerup = writable("");
export const powerupColor = writable("#ff9c4d");
export const combo = writable("");
export const comboBump = writable(0);
export const centerTitle = writable("");
export const centerBump = writable(0);
export const centerSub = writable("");
export const flashBump = writable(0);
export const flashStrength = writable(0.4);

/* ---------------------------------------------------------------- killfeed */

export interface FeedLine {
  id: number;
  html: string;
}
export const feed = writable<FeedLine[]>([]);

let feedSeq = 0;
/** Append a pre-escaped kill-feed line; cap 4, 4 s TTL (matches the old UI). */
export function pushFeed(html: string): void {
  const id = ++feedSeq;
  feed.update((lines) => {
    const next = [...lines, { id, html }];
    return next.length > 4 ? next.slice(next.length - 4) : next;
  });
  setTimeout(() => feed.update((lines) => lines.filter((l) => l.id !== id)), 4000);
}
export function clearFeed(): void {
  feed.set([]);
}

/* ------------------------------------------------------------------ modals */

export interface SettingsState {
  touch: boolean;
  mode: InputMode;
  volume: number;
  muted: boolean;
  musicVolume: number;
  musicMuted: boolean;
  quality: Quality;
  recordReplays: boolean;
  onPickMode: (m: InputMode) => void;
  onVolume: (v: number) => void;
  onMuted: (m: boolean) => void;
  onMusicVolume: (v: number) => void;
  onMusicMuted: (m: boolean) => void;
  onQuality: (q: Quality) => void;
  onRecordReplays: (on: boolean) => void;
  onClose: () => void;
}
export const settingsModal = writable<SettingsState | null>(null);

export interface InputPromptState {
  current: InputMode | null;
  onPick: (m: InputMode) => void;
  onCancel: () => void;
}
export const inputPrompt = writable<InputPromptState | null>(null);

/* --------------------------------------------------------- replay library */

export interface ReplayChip {
  color: string;
}
export interface ReplayRow {
  id: string;
  line1: string;
  chips: ReplayChip[];
  winner: string | null;
  pinned: boolean;
  partial: boolean;
  otherBuild: boolean;
  otherBuildTitle: string;
  onWatch: () => void;
  onPin: () => void;
  onSave: () => void;
  onDelete: () => void;
}
export interface ReplayLibState {
  rows: ReplayRow[];
  notice: string;
  storageLine: string;
  onBack: () => void;
  onImport: (f: File) => void;
}
export const replayLib = writable<ReplayLibState | null>(null);

/* ----------------------------------------------------------- replay viewer */

export interface ViewerMarker {
  pct: number;
  kind: "ko" | "hit" | "pickup" | "boom";
  color: string;
  title: string;
  glyph: string;
  tick: number;
}
export interface ViewerChip {
  pct: number;
  label: string;
  tick: number;
}
export interface ViewerGap {
  leftPct: number;
  widthPct: number;
}
export interface ViewerPlayer {
  id: number;
  name: string;
  color: string;
}
export interface ReplayViewerState {
  code: string;
  partial: boolean;
  buildMismatch: boolean;
  markers: ViewerMarker[];
  chips: ViewerChip[];
  gaps: ViewerGap[];
  players: ViewerPlayer[];
  speeds: readonly number[];
  onBack: () => void;
  onPrevKO: () => void;
  onNextKO: () => void;
  onTogglePlay: () => void;
  onStepBack: () => void;
  onStepFwd: () => void;
  onSpeed: (s: number) => void;
  onCamera: (m: "follow" | "free" | "playerview") => void;
  onFollow: (id: number) => void;
  onSeekTick: (tick: number) => void;
  onScrubStart: () => void;
  onScrubFrac: (f: number) => void;
  onScrubEnd: () => void;
  onExport: () => void;
}
export const replayViewer = writable<ReplayViewerState | null>(null);

// Dynamic viewer values (updated from ReplayPlayer.frame → controller.tick()).
export const rvFill = writable(0); // 0..100
export const rvTime = writable("0:00 / 0:00");
export const rvPlaying = writable(true);
export const rvSpeed = writable(1);
export const rvCam = writable<"follow" | "free" | "playerview">("follow");
export const rvFollowId = writable(-1);

/* ------------------------------------------------------------ export modal */

export interface ExportOption {
  value: string;
  label: string;
  title?: string;
  disabled?: boolean;
}
export interface ExportGroup {
  key: "camera" | "size" | "fps" | "quality" | "sound";
  label: string;
  options: ExportOption[];
  initial: string;
}
export interface ExportRangePreset {
  label: string;
  inTick: number;
  outTick: number;
}
export interface ExportSelection {
  camera: string;
  size: string;
  fps: string;
  quality: string;
  sound: string;
  inTick: number;
  outTick: number;
  name: string;
}
export interface ExportModalState {
  startTick: number;
  endTick: number;
  inTick: number;
  outTick: number;
  koPcts: number[];
  groups: ExportGroup[];
  presets: ExportRangePreset[];
  defaultName: string;
  note: string;
  canExport: boolean;
  durationLabel: (inTick: number, outTick: number) => string;
  tickLabel: (tick: number) => string;
  onClose: () => void;
  onRender: (sel: ExportSelection) => void;
  onPreviewToggle: (inTick: number, outTick: number) => void;
  onPreviewSeek: (tick: number) => void;
}
export const exportModal = writable<ExportModalState | null>(null);
export const exExporting = writable(false);
export const exProgress = writable(0); // 0..1
export const exStatus = writable("");
export const exPreviewing = writable(false);
export const exPreviewTime = writable("0:00");
export const exNote = writable("");
