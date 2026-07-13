// Replay chrome: the library screen (list / watch / pin / delete / import /
// save-as-file) and the viewer's timeline bar (scrubber with KO/hit/pickup
// markers, round chips, transport controls, speed pills, follow picker).
// Both screens own #ui the same way the live UI does — innerHTML swaps plus
// getElementById wiring — and reuse the HUD's ids (#h-feed, #h-center,
// #h-flash) so the existing kill-feed/banner/flash styles apply untouched.

import { POWERUP_NAMES } from "../net/messages";
import { colorOf, esc } from "../ui/ui";
import type { ReplayMarker } from "./format";
import type { ReplayMeta } from "./store";
import type { ReplayDataset } from "./dataset";
import type { ReplayPlayer } from "./player";
import { REPLAY_SPEEDS } from "./player";

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function replayFilename(meta: { code: string; createdAt: string }, ext: string): string {
  const stamp = meta.createdAt.slice(0, 19).replace(/[T:]/g, "-");
  return `smashzone-${meta.code}-${stamp}.${ext}`;
}

function fmtTicks(ticks: number): string {
  const s = Math.max(0, Math.floor(ticks / 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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
  constructor(private root: HTMLElement) {}

  show(
    items: ReplayMeta[],
    cbs: LibraryCallbacks,
    opts: { notice?: string; storageLine?: string; currentBuildId?: string } = {},
  ) {
    const rows = items
      .map((m) => {
        const h = m.header;
        const when = new Date(m.savedAt);
        const date = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`;
        const chips = h.players
          .map(
            (p) =>
              `<span class="rl-chip" style="--slot:${colorOf(p.slot)}">${esc(p.name)}</span>`,
          )
          .join("");
        const winner =
          h.result !== null
            ? esc(h.players.find((p) => p.id === h.result!.winner)?.name ?? "?")
            : null;
        const badges = [
          h.partial ? `<span class="rl-badge rl-partial">PARTIAL</span>` : "",
          opts.currentBuildId && h.buildId !== opts.currentBuildId
            ? `<span class="rl-badge rl-oldbuild" title="recorded on build ${esc(h.buildId)} — playback may be wrong">OTHER BUILD</span>`
            : "",
          m.pinned ? `<span class="rl-badge rl-pinned">PINNED</span>` : "",
        ].join("");
        return `
        <div class="rl-row" data-id="${m.id}">
          <div class="rl-info">
            <div class="rl-line1">
              <b>ROOM ${esc(h.code)}</b> · ${date} · ${fmtTicks(h.endTick - h.startTick)}
              · ${fmtSize(m.sizeBytes)} ${badges}
            </div>
            <div class="rl-line2">${chips}${
              winner ? `<span class="rl-winner">🏆 ${winner}</span>` : ""
            }</div>
          </div>
          <div class="rl-actions">
            <button class="rl-watch">WATCH</button>
            <button class="rl-pin secondary" title="pinned replays never auto-delete">${
              m.pinned ? "UNPIN" : "PIN"
            }</button>
            <button class="rl-save secondary" title="download as .szr file">SAVE</button>
            <button class="rl-del secondary" title="delete replay">✕</button>
          </div>
        </div>`;
      })
      .join("");

    this.root.innerHTML = `
      <div class="menu replay-lib">
        <h1 class="rl-title">REPLAYS</h1>
        <div class="error">${esc(opts.notice ?? "")}</div>
        <div class="rl-list">${
          rows ||
          `<div class="hint rl-empty">no replays yet — finish a match and it lands here automatically<br/>(the newest 10 are kept; pin the ones you love)</div>`
        }</div>
        <div class="rl-footer">
          <button id="rl-back" class="secondary">← BACK</button>
          <label class="rl-import secondary" for="rl-file">IMPORT .szr</label>
          <input id="rl-file" type="file" accept=".szr" style="display:none" />
          <span class="hint">${esc(opts.storageLine ?? "")}</span>
        </div>
      </div>`;

    (document.getElementById("rl-back") as HTMLButtonElement).onclick = cbs.onBack;
    const file = document.getElementById("rl-file") as HTMLInputElement;
    file.onchange = () => {
      const f = file.files?.[0];
      if (f) cbs.onImport(f);
      file.value = "";
    };
    for (const row of this.root.querySelectorAll<HTMLElement>(".rl-row")) {
      const id = row.dataset.id!;
      const meta = items.find((m) => m.id === id)!;
      row.querySelector<HTMLButtonElement>(".rl-watch")!.onclick = () => cbs.onWatch(id);
      row.querySelector<HTMLButtonElement>(".rl-pin")!.onclick = () =>
        cbs.onPin(id, !meta.pinned);
      row.querySelector<HTMLButtonElement>(".rl-save")!.onclick = () => cbs.onSaveFile(id);
      row.querySelector<HTMLButtonElement>(".rl-del")!.onclick = () => cbs.onDelete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Viewer chrome

const MARKER_GLYPH: Record<string, string> = {
  ko: "✖",
  pickup: "◆",
  boom: "●",
};

export class ReplayViewerUI {
  private player: ReplayPlayer | null = null;
  private keydown = (e: KeyboardEvent) => this.onKey(e);
  private lastFill = -1;
  private lastTime = "";
  private lastPlaying: boolean | null = null;
  private lastCenter = "";
  private scrubbing = false;
  private wasPlaying = false;

  constructor(private root: HTMLElement) {}

  mount(player: ReplayPlayer) {
    this.player = player;
    const ds = player.dataset;
    this.build(ds);
    window.addEventListener("keydown", this.keydown);
  }

  unmount() {
    window.removeEventListener("keydown", this.keydown);
    this.player = null;
    this.root.innerHTML = "";
  }

  // ---- per-frame refresh (cheap: writes only on change) ----

  tick() {
    const p = this.player;
    if (!p) return;
    const ds = p.dataset;
    const span = Math.max(1, ds.endTick - ds.startTick);
    const frac = (p.playheadTick - ds.startTick) / span;
    const fillPct = Math.round(frac * 1000) / 10;
    if (fillPct !== this.lastFill) {
      this.lastFill = fillPct;
      const fill = document.getElementById("rv-fill");
      const head = document.getElementById("rv-head");
      if (fill) fill.style.width = `${fillPct}%`;
      if (head) head.style.left = `${fillPct}%`;
    }
    const time = `${fmtTicks(p.playheadTick - ds.startTick)} / ${fmtTicks(span)}`;
    if (time !== this.lastTime) {
      this.lastTime = time;
      const el = document.getElementById("rv-time");
      if (el) el.textContent = time;
    }
    if (p.isPlaying !== this.lastPlaying) {
      this.lastPlaying = p.isPlaying;
      const btn = document.getElementById("rv-play");
      if (btn) btn.textContent = p.isPlaying ? "❚❚" : "▶";
    }
  }

  // ---- HUD surfaces reused by eventfx ----

  addFeed(html: string) {
    const el = document.getElementById("h-feed");
    if (!el) return;
    const line = document.createElement("div");
    line.className = "feed-line";
    line.innerHTML = html;
    el.appendChild(line);
    while (el.children.length > 4) el.removeChild(el.firstChild!);
    setTimeout(() => line.remove(), 4000);
  }

  clearFeed() {
    const el = document.getElementById("h-feed");
    if (el) el.innerHTML = "";
  }

  setCenter(title: string, sub = "") {
    const center = document.getElementById("h-title");
    const subEl = document.getElementById("h-sub");
    if (center && title !== this.lastCenter) {
      this.lastCenter = title;
      center.textContent = title;
      if (title) {
        center.classList.remove("center-pop");
        void center.offsetWidth;
        center.classList.add("center-pop");
      }
    }
    if (subEl) subEl.textContent = sub;
  }

  flash(strength = 0.4) {
    const el = document.getElementById("h-flash");
    if (!el) return;
    el.style.setProperty("--flash", String(strength));
    el.classList.remove("flash-out");
    void el.offsetWidth;
    el.classList.add("flash-out");
  }

  // ---- construction ----

  private build(ds: ReplayDataset) {
    const span = Math.max(1, ds.endTick - ds.startTick);
    const pct = (tick: number) =>
      `${(Math.max(0, Math.min(1, (tick - ds.startTick) / span)) * 100).toFixed(2)}%`;
    const players = ds.allPlayers();
    const nameOf = (id: number) => players.find((p) => p.id === id)?.name ?? "?";

    const markerHtml = (m: ReplayMarker) => {
      let cls = `rv-marker mk-${m.kind}`;
      let color = "#ffffff";
      let title = "";
      const at = fmtTicks(m.tick - ds.startTick);
      switch (m.kind) {
        case "ko":
          color = colorOf(players.find((p) => p.id === m.player)?.slot ?? 0);
          title =
            m.other >= 0
              ? `${nameOf(m.player)} KO'd by ${nameOf(m.other)} · ${at}`
              : `${nameOf(m.player)} fell · ${at}`;
          break;
        case "hit":
          color = colorOf(players.find((p) => p.id === m.player)?.slot ?? 0);
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
      const glyph = MARKER_GLYPH[m.kind] ?? "";
      return `<div class="${cls}" data-tick="${m.tick}" style="left:${pct(m.tick)};--mk:${color}" title="${esc(
        title,
      )}">${glyph}</div>`;
    };

    const chips = ds.rounds
      .filter((r) => r.countdownTick !== null || r.roundStartTick !== null)
      .map((r) => {
        const start = r.countdownTick ?? r.roundStartTick!;
        return `<button class="rv-chip" data-tick="${start}" style="left:${pct(start)}">R${r.round}</button>`;
      })
      .join("");

    const gaps = ds.gaps
      .map(
        (g) =>
          `<div class="rv-gapmark" title="connection gap" style="left:${pct(g.from)};width:calc(${pct(
            g.to,
          )} - ${pct(g.from)})"></div>`,
      )
      .join("");

    const followChips = players
      .map(
        (p) => `
        <button class="rv-pchip ${p.id === this.player!.followTargetId ? "active" : ""}"
          data-id="${p.id}" style="--slot:${colorOf(p.slot)}" title="follow ${esc(p.name)}">
          ${esc(p.name)}
        </button>`,
      )
      .join("");

    const h = ds.header;
    this.root.innerHTML = `
      <div id="h-flash"></div>
      <div class="hud-room">REPLAY · ROOM ${esc(h.code)}${
        h.partial ? " · PARTIAL" : ""
      }</div>
      <div class="hud-feed" id="h-feed"></div>
      <div class="hud-center" id="h-center"><div id="h-title"></div><div class="hud-sub" id="h-sub"></div></div>
      <div class="rv-bar">
        <div class="rv-track" id="rv-track">
          <div class="rv-chips">${chips}</div>
          ${gaps}
          <div class="rv-fill" id="rv-fill"></div>
          ${ds.markers.map(markerHtml).join("")}
          <div class="rv-head" id="rv-head"></div>
        </div>
        <div class="rv-controls" id="rv-controls">
          <button id="rv-back" class="secondary" title="back to library (Esc)">←</button>
          <button id="rv-prev" class="secondary" title="previous KO (p)">⏮ KO</button>
          <button id="rv-play" title="play/pause (Space)">❚❚</button>
          <button id="rv-next" class="secondary" title="next KO (n)">KO ⏭</button>
          <button id="rv-stepb" class="secondary" title="step back (,)">‹</button>
          <button id="rv-stepf" class="secondary" title="step forward (.)">›</button>
          <div class="rv-speeds">${REPLAY_SPEEDS.map(
            (s) =>
              `<button class="rv-speed ${s === 1 ? "active" : ""}" data-speed="${s}">${s}×</button>`,
          ).join("")}</div>
          <div id="rv-time" class="rv-time">0:00</div>
          <div class="rv-players" id="rv-players">${followChips}</div>
        </div>
      </div>`;

    this.wire();
  }

  private wire() {
    const p = () => this.player!;
    (document.getElementById("rv-back") as HTMLButtonElement).onclick = () => p().exit();
    (document.getElementById("rv-play") as HTMLButtonElement).onclick = () =>
      p().togglePlay();
    (document.getElementById("rv-prev") as HTMLButtonElement).onclick = () =>
      p().jumpToMarker(-1);
    (document.getElementById("rv-next") as HTMLButtonElement).onclick = () =>
      p().jumpToMarker(1);
    (document.getElementById("rv-stepb") as HTMLButtonElement).onclick = () =>
      p().stepSnapshots(-1);
    (document.getElementById("rv-stepf") as HTMLButtonElement).onclick = () =>
      p().stepSnapshots(1);

    for (const b of this.root.querySelectorAll<HTMLButtonElement>(".rv-speed")) {
      b.onclick = () => {
        p().setSpeed(Number(b.dataset.speed));
        for (const o of this.root.querySelectorAll(".rv-speed")) o.classList.remove("active");
        b.classList.add("active");
      };
    }

    for (const b of this.root.querySelectorAll<HTMLButtonElement>(".rv-pchip")) {
      b.onclick = () => {
        p().setFollowTarget(Number(b.dataset.id));
        for (const o of this.root.querySelectorAll(".rv-pchip")) o.classList.remove("active");
        b.classList.add("active");
      };
    }

    for (const c of this.root.querySelectorAll<HTMLButtonElement>(".rv-chip")) {
      c.onclick = (e) => {
        e.stopPropagation();
        p().seek(Number(c.dataset.tick));
      };
    }
    for (const m of this.root.querySelectorAll<HTMLElement>(".rv-marker")) {
      m.onclick = (e) => {
        e.stopPropagation();
        p().seek(Number(m.dataset.tick));
      };
    }

    // Scrub: click or drag anywhere on the track.
    const track = document.getElementById("rv-track")!;
    const seekFromEvent = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      p().seekFrac((e.clientX - r.left) / r.width);
    };
    track.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".rv-chip, .rv-marker")) return;
      this.scrubbing = true;
      this.wasPlaying = p().isPlaying;
      p().pause();
      track.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    track.addEventListener("pointermove", (e) => {
      if (this.scrubbing) seekFromEvent(e);
    });
    const endScrub = (e: PointerEvent) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      seekFromEvent(e);
      if (this.wasPlaying) p().play();
    };
    track.addEventListener("pointerup", endScrub);
    track.addEventListener("pointercancel", () => {
      this.scrubbing = false;
    });
  }

  private onKey(e: KeyboardEvent) {
    const p = this.player;
    if (!p) return;
    if (e.target instanceof HTMLInputElement) return;
    switch (e.key) {
      case " ":
        e.preventDefault();
        p.togglePlay();
        break;
      case "Escape":
        // First Esc releases pointer lock (browser handles it); this fires
        // regardless — only exit when the pointer isn't locked.
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
      default:
        return;
    }
  }
}
