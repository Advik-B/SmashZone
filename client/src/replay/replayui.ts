// Replay chrome — controllers that translate the engine's imperative calls into
// Svelte store writes. They keep the exact public method shapes ReplayPlayer and
// main.ts depend on (mount/unmount/tick/addFeed/clearFeed/setCenter/flash on the
// viewer; show() on the library) so the replay engine itself is untouched; the
// actual DOM is rendered by ReplayLibrary.svelte / ReplayViewerBar.svelte /
// ExportModal.svelte from the stores written here.

import { get } from "svelte/store";
import { colorOf } from "../ui/util";
import {
  ExportCancelled,
  webCodecsAvailable,
  type ExportHandle,
  type ExportRequest,
} from "./export";
import { prefetchFFmpeg } from "./ffmpeg";
import { downloadBlob, replayFilename } from "./download";
import { BUILD_ID, type ReplayMarker } from "./format";
import type { ReplayMeta } from "./store";
import type { ReplayDataset } from "./dataset";
import type { ReplayPlayer } from "./player";
import { REPLAY_SPEEDS } from "./player";
import { POWERUP_NAMES } from "../net/messages";
import * as S from "../ui/app/stores";

// Re-export so main.ts's existing `from "./replay/replayui"` import is unchanged.
export { downloadBlob, replayFilename };

function fmtTicks(ticks: number): string {
  const s = Math.max(0, Math.floor(ticks / 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const MARKER_GLYPH: Record<string, string> = { ko: "✖", pickup: "◆", boom: "●" };

// ---------------------------------------------------------------------------
// Library screen

export interface LibraryCallbacks {
  onWatch(id: string): void;
  onPin(id: string, pinned: boolean): void;
  onDelete(id: string): void;
  onSaveFile(id: string): void;
  onImport(file: File): void;
  onBack(): void;
}

export class ReplayLibraryUI {
  // `_root` kept only so main.ts's `new ReplayLibraryUI(#ui)` call is unchanged.
  constructor(_root: HTMLElement) {}

  show(
    items: ReplayMeta[],
    cbs: LibraryCallbacks,
    opts: { notice?: string; storageLine?: string; currentBuildId?: string } = {},
  ) {
    const rows: S.ReplayRow[] = items.map((m) => {
      const h = m.header;
      const when = new Date(m.savedAt);
      const date = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
      const line1 = `ROOM ${h.code} · ${date} · ${fmtTicks(h.endTick - h.startTick)} · ${fmtSize(
        m.sizeBytes,
      )}`;
      const winner =
        h.result !== null ? (h.players.find((p) => p.id === h.result!.winner)?.name ?? "?") : null;
      return {
        id: m.id,
        line1,
        chips: h.players.map((p) => ({ color: colorOf(p.slot) })),
        winner,
        pinned: m.pinned,
        partial: h.partial,
        otherBuild: !!(opts.currentBuildId && h.buildId !== opts.currentBuildId),
        otherBuildTitle: `recorded on build ${h.buildId} — playback may be wrong`,
        onWatch: () => cbs.onWatch(m.id),
        onPin: () => cbs.onPin(m.id, !m.pinned),
        onSave: () => cbs.onSaveFile(m.id),
        onDelete: () => cbs.onDelete(m.id),
      };
    });
    S.replayLib.set({
      rows,
      notice: opts.notice ?? "",
      storageLine: opts.storageLine ?? "",
      onBack: cbs.onBack,
      onImport: cbs.onImport,
    });
    S.screen.set("replayLib");
  }
}

// ---------------------------------------------------------------------------
// Viewer chrome

export class ReplayViewerUI {
  private player: ReplayPlayer | null = null;
  private keydown = (e: KeyboardEvent) => this.onKey(e);
  private lastFill = -1;
  private lastTime = "";
  private lastPlaying: boolean | null = null;
  private lastCenter = "";
  private wasPlaying = false;
  private exportOpen = false;
  private previewPlaying = false;
  private previewOut = 0;
  private exportHandle: ExportHandle | null = null;

  constructor(_root: HTMLElement) {}

  mount(player: ReplayPlayer) {
    this.player = player;
    this.lastFill = -1;
    this.lastTime = "";
    this.lastPlaying = null;
    this.lastCenter = "";
    S.clearFeed();
    S.centerTitle.set("");
    S.centerSub.set("");
    this.build(player.dataset);
    window.addEventListener("keydown", this.keydown);
  }

  unmount() {
    window.removeEventListener("keydown", this.keydown);
    this.player = null;
    this.exportOpen = false;
    this.previewPlaying = false;
    this.exportHandle?.cancel();
    this.exportHandle = null;
    S.replayViewer.set(null);
    S.exportModal.set(null);
    S.clearFeed();
  }

  // ---- per-frame refresh (writes only on change) ----

  tick() {
    const p = this.player;
    if (!p) return;
    const ds = p.dataset;
    const span = Math.max(1, ds.endTick - ds.startTick);
    const fillPct = Math.round(((p.playheadTick - ds.startTick) / span) * 1000) / 10;
    if (fillPct !== this.lastFill) {
      this.lastFill = fillPct;
      S.rvFill.set(fillPct);
    }
    const time = `${fmtTicks(p.playheadTick - ds.startTick)} / ${fmtTicks(span)}`;
    if (time !== this.lastTime) {
      this.lastTime = time;
      S.rvTime.set(time);
    }
    if (p.isPlaying !== this.lastPlaying) {
      this.lastPlaying = p.isPlaying;
      S.rvPlaying.set(p.isPlaying);
    }
    if (this.exportOpen) this.previewTick();
  }

  // ---- HUD surfaces reused by eventfx (shared stores rendered by HudFx) ----

  addFeed(html: string) {
    S.pushFeed(html);
  }
  clearFeed() {
    S.clearFeed();
  }
  setCenter(title: string, sub = "") {
    if (title !== this.lastCenter) {
      this.lastCenter = title;
      S.centerTitle.set(title);
      if (title) S.centerBump.update((n) => n + 1);
    }
    S.centerSub.set(sub);
  }
  flash(strength = 0.4) {
    S.flashStrength.set(strength);
    S.flashBump.update((n) => n + 1);
  }

  // ---- construction ----

  private build(ds: ReplayDataset) {
    const span = Math.max(1, ds.endTick - ds.startTick);
    const pct = (tick: number) => Math.max(0, Math.min(1, (tick - ds.startTick) / span)) * 100;
    const players = ds.allPlayers();
    const nameOf = (id: number) => players.find((p) => p.id === id)?.name ?? "?";
    const slotOf = (id: number) => players.find((p) => p.id === id)?.slot ?? 0;

    const markers: S.ViewerMarker[] = ds.markers.map((m: ReplayMarker) => {
      let color = "#ffffff";
      let title = "";
      const at = fmtTicks(m.tick - ds.startTick);
      switch (m.kind) {
        case "ko":
          color = colorOf(slotOf(m.player));
          title =
            m.other >= 0
              ? `${nameOf(m.player)} KO'd by ${nameOf(m.other)} · ${at}`
              : `${nameOf(m.player)} fell · ${at}`;
          break;
        case "hit":
          color = colorOf(slotOf(m.player));
          title = `${nameOf(m.player)} smacked ${nameOf(m.other)} (${m.data}) · ${at}`;
          break;
        case "pickup":
          color = "#ffe94d";
          title = `${nameOf(m.player)} grabbed ${POWERUP_NAMES[m.data] ?? "?"} · ${at}`;
          break;
        case "boom":
          color = "#ff9c4d";
          title = `bomb blast · ${at}`;
          break;
      }
      return {
        pct: pct(m.tick),
        kind: m.kind,
        color,
        title,
        glyph: MARKER_GLYPH[m.kind] ?? "",
        tick: m.tick,
      };
    });

    const chips: S.ViewerChip[] = ds.rounds
      .filter((r) => r.countdownTick !== null || r.roundStartTick !== null)
      .map((r) => {
        const start = r.countdownTick ?? r.roundStartTick!;
        return { pct: pct(start), label: `R${r.round}`, tick: start };
      });

    const gaps: S.ViewerGap[] = ds.gaps.map((g) => ({
      leftPct: pct(g.from),
      widthPct: pct(g.to) - pct(g.from),
    }));

    const vplayers: S.ViewerPlayer[] = players.map((p) => ({
      id: p.id,
      name: p.name,
      color: colorOf(p.slot),
    }));

    const h = ds.header;
    S.rvFollowId.set(this.player!.followTargetId);
    S.rvCam.set("follow");
    S.rvSpeed.set(1);
    S.rvPlaying.set(true);
    S.rvFill.set(0);
    S.rvTime.set(`0:00 / ${fmtTicks(span)}`);
    S.replayViewer.set({
      code: h.code,
      partial: h.partial,
      buildMismatch: h.buildId !== BUILD_ID,
      markers,
      chips,
      gaps,
      players: vplayers,
      speeds: REPLAY_SPEEDS,
      onBack: () => this.player?.exit(),
      onPrevKO: () => this.player?.jumpToMarker(-1),
      onNextKO: () => this.player?.jumpToMarker(1),
      onTogglePlay: () => this.player?.togglePlay(),
      onStepBack: () => this.player?.stepSnapshots(-1),
      onStepFwd: () => this.player?.stepSnapshots(1),
      onSpeed: (s) => this.setSpeed(s),
      onCamera: (m) => this.setCam(m),
      onFollow: (id) => this.setFollow(id),
      onSeekTick: (tick) => this.player?.seek(tick),
      onScrubStart: () => {
        this.wasPlaying = this.player?.isPlaying ?? false;
        this.player?.pause();
      },
      onScrubFrac: (f) => this.player?.seekFrac(f),
      onScrubEnd: () => {
        if (this.wasPlaying) this.player?.play();
      },
      onExport: () => this.openExport(),
    });
    S.screen.set("replayViewer");
  }

  private setCam(mode: "follow" | "free" | "playerview") {
    this.player?.setCameraMode(mode);
    S.rvCam.set(mode);
  }
  private setSpeed(s: number) {
    this.player?.setSpeed(s);
    S.rvSpeed.set(s);
  }
  private setFollow(id: number) {
    this.player?.setFollowTarget(id);
    S.rvFollowId.set(id);
  }

  // ---- export dialog ----

  private openExport() {
    const p = this.player;
    if (!p || p.isExporting || get(S.exportModal)) return;
    p.pause();
    const ds = p.dataset;
    const players = ds.allPlayers();
    const targetName = players.find((x) => x.id === p.followTargetId)?.name ?? "player";
    const canExport = webCodecsAvailable();
    // Warm the ffmpeg core (~32 MB, cached) while the user trims the range.
    if (canExport) prefetchFFmpeg();
    const span = Math.max(1, ds.endTick - ds.startTick);
    const koPcts = ds.markers
      .filter((m) => m.kind === "ko")
      .map((m) => Math.max(0, Math.min(1, (m.tick - ds.startTick) / span)) * 100);
    const round = ds.roundAt(p.playheadTick);

    const presets: S.ExportRangePreset[] = [
      { label: "Whole match", inTick: ds.startTick, outTick: ds.endTick },
      ...ds.rounds
        .filter((r) => r.countdownTick !== null || r.roundStartTick !== null)
        .map((r) => ({
          label: `Round ${r.round}`,
          inTick: r.countdownTick ?? r.roundStartTick ?? ds.startTick,
          outTick: r.endTick ?? ds.endTick,
        })),
    ];

    const groups: S.ExportGroup[] = [
      {
        key: "camera",
        label: "CAMERA",
        initial: "follow",
        options: [
          { value: "follow", label: `Follow ${targetName}` },
          {
            value: "playerview",
            label: `${targetName}'s POV`,
            title: "exact for the recording player, approximate for others",
          },
        ],
      },
      {
        key: "size",
        label: "SIZE",
        initial: "720",
        options: [
          { value: "720", label: "720p" },
          { value: "1080", label: "1080p" },
        ],
      },
      {
        key: "fps",
        label: "FPS",
        initial: "60",
        options: [
          { value: "30", label: "30" },
          { value: "60", label: "60" },
        ],
      },
      {
        key: "quality",
        label: "QUALITY",
        initial: "standard",
        options: [
          { value: "standard", label: "Standard" },
          { value: "high", label: "High · bigger file" },
        ],
      },
      {
        key: "sound",
        label: "SOUND",
        initial: "on",
        options: [
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ],
      },
    ];

    const inTick = round ? (round.countdownTick ?? round.roundStartTick ?? ds.startTick) : ds.startTick;
    const outTick = round ? (round.endTick ?? ds.endTick) : ds.endTick;

    S.exExporting.set(false);
    S.exProgress.set(0);
    S.exStatus.set("");
    S.exPreviewing.set(false);
    S.exNote.set(
      canExport
        ? "renders faster than real time, with game audio — the tab can stay in the background"
        : "this browser can't export video (WebCodecs is required)",
    );
    this.exportOpen = true;
    this.previewPlaying = false;
    p.seek(inTick);

    S.exportModal.set({
      startTick: ds.startTick,
      endTick: ds.endTick,
      inTick,
      outTick,
      koPcts,
      groups,
      presets,
      defaultName: replayFilename(ds.header, "").replace(/\.$/, ""),
      note: get(S.exNote),
      canExport,
      durationLabel: (i, o) => fmtTicks(o - i),
      tickLabel: (t) => fmtTicks(t - ds.startTick),
      onClose: () => this.closeExport(),
      onRender: (sel) => void this.runExport(sel),
      onPreviewToggle: (i, o) => this.togglePreview(i, o),
      onPreviewSeek: (t) => {
        this.previewPlaying = false;
        S.exPreviewing.set(false);
        this.player?.pause();
        this.player?.seek(t);
      },
    });
  }

  private closeExport() {
    this.exportHandle?.cancel();
    this.exportHandle = null;
    this.exportOpen = false;
    this.previewPlaying = false;
    S.exPreviewing.set(false);
    S.exportModal.set(null);
  }

  private async runExport(sel: S.ExportSelection) {
    const p = this.player;
    if (!p || this.exportHandle || !webCodecsAvailable()) return;
    const [width, height] = sel.size === "1080" ? [1920, 1080] : [1280, 720];
    const req: ExportRequest = {
      width,
      height,
      fps: sel.fps === "30" ? 30 : 60,
      camera: sel.camera === "playerview" ? "playerview" : "follow",
      targetId: p.followTargetId,
      startTick: sel.inTick,
      endTick: sel.outTick,
      quality: sel.quality === "high" ? "high" : "standard",
      sound: sel.sound !== "off",
      onProgress: (f) => S.exProgress.set(f),
      onPhase: (ph) =>
        S.exStatus.set(
          ph === "render"
            ? "rendering frames…"
            : ph === "audio"
              ? "rendering audio…"
              : "encoding mp4…",
        ),
    };
    this.previewPlaying = false;
    S.exPreviewing.set(false);
    S.exExporting.set(true);
    S.exProgress.set(0);
    S.exStatus.set("rendering…");
    try {
      this.exportHandle = p.startExport(req);
      const blob = await this.exportHandle.done;
      const name = sel.name.trim()
        ? `${sel.name.trim()}.mp4`
        : replayFilename(p.dataset.header, "mp4");
      downloadBlob(blob, name);
      S.exStatus.set("saved!");
      setTimeout(() => this.closeExport(), 900);
    } catch (e) {
      if (e instanceof ExportCancelled) {
        this.closeExport();
      } else {
        S.exStatus.set(`export failed: ${e instanceof Error ? e.message : e}`);
        S.exExporting.set(false);
        this.exportHandle = null;
      }
    }
  }

  private togglePreview(inTick: number, outTick: number) {
    const p = this.player;
    if (!p) return;
    if (this.previewPlaying) {
      this.previewPlaying = false;
      p.pause();
      S.exPreviewing.set(false);
      return;
    }
    this.previewPlaying = true;
    this.previewOut = outTick;
    p.setSpeed(1);
    p.seek(inTick);
    p.play();
    S.exPreviewing.set(true);
  }

  /** Mirror the live #game render into the modal's #ex-prev canvas. */
  private previewTick() {
    const p = this.player;
    if (!p) return;
    if (this.previewPlaying && p.playheadTick >= this.previewOut) {
      this.previewPlaying = false;
      p.pause();
      S.exPreviewing.set(false);
    }
    const src = document.getElementById("game") as HTMLCanvasElement | null;
    const dst = document.getElementById("ex-prev") as HTMLCanvasElement | null;
    if (src && dst) {
      const ctx = dst.getContext("2d");
      if (ctx) {
        if (dst.width !== dst.clientWidth) dst.width = dst.clientWidth;
        if (dst.height !== dst.clientHeight) dst.height = dst.clientHeight;
        try {
          ctx.drawImage(src, 0, 0, dst.width, dst.height);
        } catch {
          /* cross-frame draw can briefly fail mid-resize; ignore */
        }
      }
    }
    S.exPreviewTime.set(fmtTicks(p.playheadTick - p.dataset.startTick));
  }

  private onKey(e: KeyboardEvent) {
    const p = this.player;
    if (!p) return;
    if (e.target instanceof HTMLInputElement) return;
    if (get(S.exportModal)) {
      if (e.key === "Escape") this.closeExport();
      return;
    }
    switch (e.key) {
      case " ":
        e.preventDefault();
        p.togglePlay();
        break;
      case "Escape":
        if (!document.pointerLockElement) p.exit();
        break;
      case ",":
        p.stepSnapshots(-1);
        break;
      case ".":
        p.stepSnapshots(1);
        break;
      case "p":
        p.jumpToMarker(-1);
        break;
      case "n":
        p.jumpToMarker(1);
        break;
      case "1":
        this.setCam("follow");
        break;
      case "2":
        this.setCam("free");
        break;
      case "3":
        this.setCam("playerview");
        break;
      default:
        return;
    }
  }
}
