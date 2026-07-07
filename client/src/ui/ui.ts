import type { Phase, PlayerMeta, Score } from "../net/messages";
import { isTouchDevice } from "../game/input";
import { SLOT_COLORS } from "../game/players";
import { hintItem, hintRow, keycap, mouseIcon, wasdCluster } from "./icons";

function colorOf(slot: number): string {
  return "#" + SLOT_COLORS[slot % SLOT_COLORS.length].toString(16).padStart(6, "0");
}

function menuControlsHint(): string {
  if (isTouchDevice()) {
    return `<span class="hint-row"><span class="hint-item">left stick to move · drag to aim · tap buttons to fight</span></span>`;
  }
  return hintRow([
    hintItem(wasdCluster(), "move"),
    hintItem(mouseIcon("move"), "aim"),
    hintItem(mouseIcon("left"), "light"),
    hintItem(mouseIcon("right"), "heavy"),
    hintItem(keycap("Space", true), "jump"),
    hintItem(keycap("Shift", true), "dash"),
  ]);
}

function hudControlsHint(): string {
  return (
    hintRow([
      hintItem(wasdCluster(), "move"),
      hintItem(keycap("Space", true), "jump ×2"),
      hintItem(keycap("Shift", true), "dash"),
    ]) +
    "<br>" +
    hintRow([
      hintItem(mouseIcon("left"), "light"),
      hintItem(mouseIcon("right"), "heavy / air-slam"),
    ])
  );
}

export interface PhaseCtx {
  myId: number;
  host: number;
  metas: Map<number, PlayerMeta>;
  code: string;
  onStart: () => void;
  onRematch: () => void;
}

export class UI {
  private root = document.getElementById("ui")!;
  private hudDamage: HTMLElement | null = null;
  private hudCenter: HTMLElement | null = null;
  private hudSub: HTMLElement | null = null;
  private hudScores: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;

  showMenu(
    onCreate: (name: string) => void,
    onJoin: (name: string, code: string) => void,
    error = "",
  ) {
    const saved = localStorage.getItem("sz-name") ?? "";
    this.root.innerHTML = `
      <div class="menu">
        <h1>SMASHZONE</h1>
        <div class="error">${error}</div>
        <input id="m-name" maxlength="16" placeholder="your name" value="${saved}" />
        <button id="m-create">Create Party</button>
        <div class="row">
          <input id="m-code" maxlength="4" placeholder="CODE" />
          <button id="m-join" class="secondary">Join</button>
        </div>
        <div class="hint">${menuControlsHint()}</div>
      </div>`;
    const name = () => {
      const v = (document.getElementById("m-name") as HTMLInputElement).value.trim() || "Player";
      localStorage.setItem("sz-name", v);
      return v;
    };
    document.getElementById("m-create")!.onclick = () => onCreate(name());
    const join = () => {
      const code = (document.getElementById("m-code") as HTMLInputElement).value.trim().toUpperCase();
      if (code.length === 4) onJoin(name(), code);
    };
    document.getElementById("m-join")!.onclick = join;
    (document.getElementById("m-code") as HTMLInputElement).onkeydown = (e) => {
      if (e.key === "Enter") join();
    };
  }

  showConnecting() {
    this.root.innerHTML = `<div class="menu"><h1>SMASHZONE</h1><div>connecting…</div></div>`;
  }

  buildHud(code: string) {
    this.root.innerHTML = `
      <div class="hud-room">ROOM ${code} · <span id="h-ping"></span></div>
      <div class="hud-scores" id="h-scores"></div>
      <div class="hud-damage" id="h-damage"></div>
      <div class="hud-powerup" id="h-powerup"></div>
      <div class="hud-center" id="h-center"><div id="h-title"></div><div class="hud-sub" id="h-sub"></div></div>
      <div id="h-overlay"></div>
      ${isTouchDevice() ? "" : `<div class="controls-hint">${hudControlsHint()}</div>`}`;
    this.hudDamage = document.getElementById("h-damage");
    this.hudCenter = document.getElementById("h-title");
    this.hudSub = document.getElementById("h-sub");
    this.hudScores = document.getElementById("h-scores");
    this.overlay = document.getElementById("h-overlay");
  }

  setPowerup(name: string, secs: number, colorHex: string) {
    const el = document.getElementById("h-powerup");
    if (!el) return;
    if (!name) {
      el.textContent = "";
      return;
    }
    el.textContent = `${name} ${Math.max(0, Math.ceil(secs))}s`;
    el.style.color = colorHex;
  }

  setPing(ms: number) {
    const el = document.getElementById("h-ping");
    if (el) el.textContent = `${Math.max(0, Math.round(ms))}ms`;
  }

  setDamage(dmg: number, alive: boolean) {
    if (!this.hudDamage) return;
    this.hudDamage.textContent = alive ? `${dmg}%` : "";
    const heat = Math.min(1, dmg / 150);
    this.hudDamage.style.color = `rgb(255, ${Math.round(255 - heat * 190)}, ${Math.round(
      255 - heat * 230,
    )})`;
  }

  setCenter(title: string, sub = "") {
    if (this.hudCenter) this.hudCenter.textContent = title;
    if (this.hudSub) this.hudSub.textContent = sub;
  }

  setScores(metas: Map<number, PlayerMeta>, scores: Score[], aliveIds?: Set<number>) {
    if (!this.hudScores) return;
    const wins = new Map(scores.map((s) => [s.id, s.wins]));
    this.hudScores.innerHTML = [...metas.values()]
      .map((m) => {
        const dead = aliveIds && !aliveIds.has(m.id);
        return `<div class="row ${dead ? "dead" : ""}">
          <div class="dot" style="background:${colorOf(m.slot)}"></div>
          <span>${m.name}</span><b>${wins.get(m.id) ?? 0}</b>
        </div>`;
      })
      .join("");
  }

  /** Full-screen overlays for lobby / match end. */
  setPhaseOverlay(phase: Phase, ctx: PhaseCtx) {
    if (!this.overlay) return;
    if (phase.type === "Lobby") {
      const isHost = ctx.myId === ctx.host;
      this.overlay.innerHTML = `
        <div class="lobby-panel">
          <div class="hint">share this code</div>
          <div class="code">${ctx.code}</div>
          <div class="players">${[...ctx.metas.values()]
            .map(
              (m) =>
                `<div class="pcard" style="border-color:${colorOf(m.slot)}">${m.name}${
                  m.id === ctx.host ? " ★" : ""
                }</div>`,
            )
            .join("")}</div>
          ${
            isHost
              ? `<button id="h-start" class="menu-btn" style="font-size:22px;padding:14px 44px;border-radius:12px;border:none;cursor:pointer;background:linear-gradient(135deg,#ff5e7d,#a15eff);color:#fff;font-weight:800">START MATCH</button>`
              : `<div class="hint">waiting for the host to start…</div>`
          }
          <div class="hint">you can run around and brawl while you wait — falling off just respawns you</div>
        </div>`;
      const btn = document.getElementById("h-start");
      if (btn) btn.onclick = ctx.onStart;
    } else if (phase.type === "MatchEnd") {
      const isHost = ctx.myId === ctx.host;
      const winner = ctx.metas.get(phase.winner);
      this.overlay.innerHTML = `
        <div class="lobby-panel">
          <div class="code" style="letter-spacing:2px">${winner?.name ?? "???"} WINS!</div>
          <div class="players">${phase.scores
            .map((s) => {
              const m = ctx.metas.get(s.id);
              return `<div class="pcard" style="border-color:${colorOf(m?.slot ?? 0)}">${
                m?.name ?? "?"
              }<br><b style="font-size:26px">${s.wins}</b></div>`;
            })
            .join("")}</div>
          ${
            isHost
              ? `<button id="h-rematch" style="font-size:22px;padding:14px 44px;border-radius:12px;border:none;cursor:pointer;background:linear-gradient(135deg,#ff5e7d,#a15eff);color:#fff;font-weight:800">REMATCH</button>`
              : `<div class="hint">waiting for the host…</div>`
          }
        </div>`;
      const btn = document.getElementById("h-rematch");
      if (btn) btn.onclick = ctx.onRematch;
    } else {
      this.overlay.innerHTML = "";
    }
  }
}
