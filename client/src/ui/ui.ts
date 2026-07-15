// UI controller. Keeps the exact method surface GameClient and main.ts call
// (showMenu / showSettings / buildHud / setDamage / setScores / setPhaseOverlay
// …) but, instead of building innerHTML, it writes Svelte stores that App.svelte
// renders. Hot per-frame setters debounce (only .set() on change) so the reactive
// churn stays minimal. The engine is untouched.

import { BOT_DIFF_NAMES, type Phase, type PlayerMeta, type Score } from "../net/messages";
import constants from "../../../shared/constants.json";
import { isTouchDevice, savedInputMode, type InputMode } from "../game/input";
import type { Quality } from "../game/quality";
import { colorOf, esc } from "./util";
import * as S from "./app/stores";

// Re-export the shared helpers eventfx.ts imports from here.
export { colorOf, esc };

export interface PhaseCtx {
  myId: number;
  host: number;
  metas: Map<number, PlayerMeta>;
  code: string;
  onStart: () => void;
  onRematch: () => void;
  onAddBot: (difficulty: number) => void;
  onRemoveBot: (id: number) => void;
  /** Present once the finished match's recording is saved (match-end panel). */
  onWatchReplay?: (() => void) | null;
  /** Fallback when the recording exists but couldn't be persisted (quota,
   *  private mode): offer a direct .szr download instead. */
  onSaveReplayFile?: (() => void) | null;
}

export class UI {
  private lastDmg = -1;
  private lastDmgText = "";
  private lastDmgColor = "";
  private lastPowerup = "";
  private lastPowerupColor = "";
  private lastPing = "";
  private lastCombo = "";
  private lastCenter = "";
  private lastSub = "";

  constructor() {
    // Enter presses START MATCH / REMATCH so a keyboard-only host never needs
    // the pointer. A single persistent listener (Svelte owns/rebuilds the
    // buttons); deliberately not focus()-based — a focused button would be
    // activated by Space, which is the jump key.
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.repeat) return;
      if (e.target instanceof HTMLInputElement) return;
      const btn = document.getElementById("h-start") ?? document.getElementById("h-rematch");
      if (btn) {
        e.preventDefault();
        (btn as HTMLButtonElement).click();
      }
    });
  }

  showMenu(
    onCreate: (name: string) => void,
    onJoin: (name: string, code: string) => void,
    error = "",
    onChangeControls: (() => void) | null = null,
    onReplays: (() => void) | null = null,
  ) {
    S.menu.set({
      error,
      touch: isTouchDevice(),
      mode: savedInputMode(),
      showReplays: !!onReplays,
      onCreate,
      onJoin,
      onSettings: onChangeControls ?? (() => {}),
      onReplays: onReplays ?? (() => {}),
    });
    S.screen.set("menu");
  }

  /** First-join gate: how the player aims. Keyboard-operable; closes on pick. */
  showInputModePrompt(
    current: InputMode | null,
    onPick: (m: InputMode) => void,
    onCancel: () => void,
  ) {
    S.inputPrompt.set({
      current,
      onPick: (m) => {
        S.inputPrompt.set(null);
        onPick(m);
      },
      onCancel: () => {
        S.inputPrompt.set(null);
        onCancel();
      },
    });
  }

  /** Settings modal: input scheme, audio, quality, auto-record. Live-applies. */
  showSettings(opts: {
    onPickMode: (m: InputMode) => void;
    volume: number;
    muted: boolean;
    onVolume: (v: number) => void;
    onMuted: (m: boolean) => void;
    musicVolume: number;
    musicMuted: boolean;
    onMusicVolume: (v: number) => void;
    onMusicMuted: (m: boolean) => void;
    quality: Quality;
    onQuality: (q: Quality) => void;
    recordReplays: boolean;
    onRecordReplays: (on: boolean) => void;
  }) {
    S.settingsModal.set({
      touch: isTouchDevice(),
      mode: savedInputMode(),
      volume: opts.volume,
      muted: opts.muted,
      musicVolume: opts.musicVolume,
      musicMuted: opts.musicMuted,
      quality: opts.quality,
      recordReplays: opts.recordReplays,
      onPickMode: opts.onPickMode,
      onVolume: opts.onVolume,
      onMuted: opts.onMuted,
      onMusicVolume: opts.onMusicVolume,
      onMusicMuted: opts.onMusicMuted,
      onQuality: opts.onQuality,
      onRecordReplays: opts.onRecordReplays,
      onClose: () => S.settingsModal.set(null),
    });
  }

  showConnecting() {
    S.screen.set("connecting");
  }

  buildHud(code: string) {
    S.hudCode.set(code);
    S.overlay.set({ kind: "none" });
    S.scores.set([]);
    S.clearFeed();
    S.damage.set("");
    S.powerup.set("");
    S.combo.set("");
    S.ping.set("");
    S.centerTitle.set("");
    S.centerSub.set("");
    this.lastDmg = -1;
    this.lastDmgText = "";
    this.lastDmgColor = "";
    this.lastPowerup = "";
    this.lastPowerupColor = "";
    this.lastPing = "";
    this.lastCombo = "";
    this.lastCenter = "";
    this.lastSub = "";
    S.screen.set("hud");
  }

  /** Combo readout ("N HITS"); hidden below 2 hits. */
  setCombo(n: number) {
    const text = n < 2 ? "" : `${n} HITS`;
    if (text !== this.lastCombo) {
      this.lastCombo = text;
      S.combo.set(text);
    }
    if (text) S.comboBump.update((x) => x + 1);
  }

  /** Full-screen white flash (KO punctuation). */
  flash(strength = 0.4) {
    S.flashStrength.set(strength);
    S.flashBump.update((x) => x + 1);
  }

  setPowerup(name: string, secs: number, colorHex: string) {
    const text = name ? `${name} ${Math.max(0, Math.ceil(secs))}s` : "";
    if (text !== this.lastPowerup) {
      this.lastPowerup = text;
      S.powerup.set(text);
    }
    if (colorHex !== this.lastPowerupColor) {
      this.lastPowerupColor = colorHex;
      S.powerupColor.set(colorHex);
    }
  }

  setPing(ms: number) {
    const text = `${Math.max(0, Math.round(ms))}ms`;
    if (text !== this.lastPing) {
      this.lastPing = text;
      S.ping.set(text);
    }
  }

  /** Append a kill-feed line (caller pre-escapes any names). */
  addFeed(html: string) {
    S.pushFeed(html);
  }

  setDamage(dmg: number, alive: boolean) {
    const text = alive ? `${dmg}%` : "";
    if (text !== this.lastDmgText) {
      this.lastDmgText = text;
      S.damage.set(text);
    }
    const heat = Math.min(1, dmg / 150);
    const color = `rgb(255, ${Math.round(255 - heat * 190)}, ${Math.round(255 - heat * 230)})`;
    if (color !== this.lastDmgColor) {
      this.lastDmgColor = color;
      S.damageColor.set(color);
    }
    // Pop on increase only (this runs every frame).
    if (alive && this.lastDmg >= 0 && dmg > this.lastDmg) S.damageBump.update((x) => x + 1);
    this.lastDmg = alive ? dmg : -1;
  }

  setCenter(title: string, sub = "") {
    // Slam-in only when the text actually changes — called every frame during
    // countdown with the same string.
    if (title !== this.lastCenter) {
      this.lastCenter = title;
      S.centerTitle.set(title);
      if (title) S.centerBump.update((x) => x + 1);
    }
    if (sub !== this.lastSub) {
      this.lastSub = sub;
      S.centerSub.set(sub);
    }
  }

  setScores(
    metas: Map<number, PlayerMeta>,
    scores: Score[],
    aliveIds?: Set<number>,
    disconnectedIds?: Set<number>,
  ) {
    const wins = new Map(scores.map((s) => [s.id, s.wins]));
    S.scores.set(
      [...metas.values()].map((m) => ({
        id: m.id,
        name: m.name,
        color: colorOf(m.slot),
        wins: wins.get(m.id) ?? 0,
        dead: !!(aliveIds && !aliveIds.has(m.id)),
        disconnected: !!disconnectedIds?.has(m.id),
        bot: m.bot,
        difficulty: m.difficulty,
      })),
    );
  }

  /** Full-screen overlays for lobby / match end (rendered inside #h-overlay). */
  setPhaseOverlay(phase: Phase, ctx: PhaseCtx) {
    if (phase.type === "Lobby") {
      const isHost = ctx.myId === ctx.host;
      const canAddBot = isHost && ctx.metas.size < constants.maxPlayers;
      const players: S.PlayerCard[] = [...ctx.metas.values()].map((m) => ({
        id: m.id,
        name: m.name,
        color: colorOf(m.slot),
        bot: m.bot,
        difficulty: m.difficulty,
        host: m.id === ctx.host,
        wins: 0,
        best: false,
        removable: isHost && m.bot,
      }));
      S.overlay.set({
        kind: "lobby",
        code: ctx.code,
        players,
        isHost,
        canAddBot,
        botTiers: [...BOT_DIFF_NAMES],
        onStart: ctx.onStart,
        onAddBot: ctx.onAddBot,
        onRemoveBot: ctx.onRemoveBot,
        onCopyCode: () => this.copyCode(ctx.code),
      });
    } else if (phase.type === "MatchEnd") {
      const isHost = ctx.myId === ctx.host;
      const winner = ctx.metas.get(phase.winner);
      const players: S.PlayerCard[] = phase.scores.map((s) => {
        const m = ctx.metas.get(s.id);
        return {
          id: s.id,
          name: m?.name ?? "?",
          color: colorOf(m?.slot ?? 0),
          bot: m?.bot ?? false,
          difficulty: m?.difficulty ?? 0,
          host: false,
          wins: s.wins,
          best: s.id === phase.winner,
          removable: false,
        };
      });
      S.overlay.set({
        kind: "matchend",
        winnerName: winner?.name ?? "???",
        players,
        isHost,
        onRematch: ctx.onRematch,
        onWatchReplay: ctx.onWatchReplay ?? null,
        onSaveReplayFile: ctx.onSaveReplayFile ?? null,
      });
    } else {
      S.overlay.set({ kind: "none" });
    }
  }

  private copyCode(code: string) {
    navigator.clipboard?.writeText(code).catch(() => {});
    S.lobbyCopied.set(true);
    setTimeout(() => S.lobbyCopied.set(false), 1500);
  }
}
