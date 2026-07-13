import { BOT_DIFF_NAMES, type Phase, type PlayerMeta, type Score } from "../net/messages";
import constants from "../../../shared/constants.json";
import { isTouchDevice, savedInputMode, type InputMode } from "../game/input";
import type { Quality } from "../game/quality";
import { SLOT_COLORS } from "../game/players";
import {
  arrowCluster,
  gearIcon,
  hintItem,
  hintRow,
  keycap,
  mouseIcon,
  wasdCluster,
} from "./icons";

export function colorOf(slot: number): string {
  return "#" + SLOT_COLORS[slot % SLOT_COLORS.length].toString(16).padStart(6, "0");
}

/** Restart a CSS keyframe animation class on an element. */
function retrigger(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth; // force reflow so the animation replays
  el.classList.add(cls);
}

/**
 * Escape untrusted text (player names, server error strings) before it goes
 * into innerHTML. Player names come straight off the wire from other clients,
 * so treating them as markup would be a stored-XSS hole.
 */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function menuControlsHint(): string {
  if (isTouchDevice()) {
    return `<span class="hint-row"><span class="hint-item">left stick to move · drag to aim · tap buttons to fight</span></span>`;
  }
  if (savedInputMode() === "keyboard") {
    return hintRow([
      hintItem(wasdCluster(), "move"),
      hintItem(arrowCluster(), "aim"),
      hintItem(keycap("J"), "light"),
      hintItem(keycap("K"), "heavy"),
      hintItem(keycap("Space", true), "jump"),
      hintItem(keycap("Shift", true), "dash"),
      hintItem(keycap("C"), "center cam"),
    ]);
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
  const kb = savedInputMode() === "keyboard";
  return (
    hintRow([
      hintItem(wasdCluster(), "move"),
      ...(kb ? [hintItem(arrowCluster(), "aim")] : []),
      hintItem(keycap("Space", true), "jump ×2"),
      hintItem(keycap("Shift", true), "dash"),
    ]) +
    "<br>" +
    hintRow(
      kb
        ? [
            hintItem(keycap("J"), "light"),
            hintItem(keycap("K"), "heavy / air-slam"),
            hintItem(keycap("C"), "center camera"),
          ]
        : [
            hintItem(mouseIcon("left"), "light"),
            hintItem(mouseIcon("right"), "heavy / air-slam"),
          ],
    )
  );
}

/** The two selectable schemes, rendered as cards in the input-mode prompt. */
function modeCard(mode: InputMode): string {
  const title = mode === "keyboard" ? "Keyboard + Trackpad" : "Keyboard + Mouse";
  const sub =
    mode === "keyboard"
      ? `<span class="hint">keyboard-only controls — no mouse needed</span>`
      : `<span class="hint">aim with the mouse, pointer is captured</span>`;
  const aimRow =
    mode === "keyboard"
      ? hintRow([
          hintItem(arrowCluster(), "aim"),
          hintItem(keycap("J"), "light"),
          hintItem(keycap("K"), "heavy"),
          hintItem(keycap("C"), "center cam"),
        ])
      : hintRow([
          hintItem(mouseIcon("move"), "aim"),
          hintItem(mouseIcon("left"), "light"),
          hintItem(mouseIcon("right"), "heavy"),
        ]);
  const moveRow = hintRow([
    hintItem(wasdCluster(), "move"),
    hintItem(keycap("Space", true), "jump"),
    hintItem(keycap("Shift", true), "dash"),
  ]);
  return `<button class="mode-card" data-mode="${mode}">
      <b>${title}</b>${sub}${moveRow}${aimRow}
    </button>`;
}

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
}

export class UI {
  private root = document.getElementById("ui")!;
  private hudDamage: HTMLElement | null = null;
  private hudCenter: HTMLElement | null = null;
  private hudSub: HTMLElement | null = null;
  private hudScores: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private hudCombo: HTMLElement | null = null;
  private hudFlash: HTMLElement | null = null;
  private lastCenter = "";
  private lastDmg = -1;
  private lastWins = new Map<number, number>();

  constructor() {
    // Enter presses START MATCH / REMATCH so a keyboard-only host never needs
    // the pointer. A single persistent listener (the overlay's innerHTML is
    // rebuilt every phase change, so per-button listeners wouldn't survive);
    // deliberately not focus()-based — a focused button would be activated by
    // Space, which is the jump key.
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
    const saved = localStorage.getItem("sz-name") ?? "";
    const modeLabel =
      savedInputMode() === "keyboard" ? "keyboard + trackpad" : "keyboard + mouse";
    this.root.innerHTML = `
      <div class="menu">
        ${
          onChangeControls
            ? `<button id="m-settings" class="menu-gear" aria-label="Input & controls settings" title="Input & controls">${gearIcon()}</button>`
            : ""
        }
        <h1>SMASHZONE</h1>
        <div class="error">${esc(error)}</div>
        <input id="m-name" maxlength="16" placeholder="your name" value="${esc(saved)}" />
        <button id="m-create">Create Party</button>
        <div class="row">
          <input id="m-code" maxlength="4" placeholder="CODE" />
          <button id="m-join" class="secondary">Join</button>
        </div>
        ${onReplays ? `<button id="m-replays" class="secondary">Replays</button>` : ""}
        <div class="hint">${menuControlsHint()}</div>
        ${
          onChangeControls
            ? `<div class="hint">controls: ${modeLabel} <button id="m-mode" class="linklike">change</button></div>`
            : ""
        }
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
    (document.getElementById("m-name") as HTMLInputElement).onkeydown = (e) => {
      if (e.key === "Enter") onCreate(name());
    };
    if (onChangeControls) {
      const modeBtn = document.getElementById("m-mode");
      if (modeBtn) modeBtn.onclick = onChangeControls;
      const settingsBtn = document.getElementById("m-settings");
      if (settingsBtn) settingsBtn.onclick = onChangeControls;
    }
    if (onReplays) {
      const replaysBtn = document.getElementById("m-replays");
      if (replaysBtn) replaysBtn.onclick = onReplays;
    }
  }

  /**
   * Modal asking how the player aims. Fully keyboard-operable: arrows/Tab
   * move between the cards, Enter confirms, Esc cancels. Appended on top of
   * whatever screen is showing (never replaces it), removed on close.
   */
  showInputModePrompt(
    current: InputMode | null,
    onPick: (m: InputMode) => void,
    onCancel: () => void,
  ) {
    const modal = document.createElement("div");
    modal.className = "mode-modal";
    modal.innerHTML = `
      <h2>HOW DO YOU PLAY?</h2>
      <div class="mode-cards">${modeCard("pointer")}${modeCard("keyboard")}</div>
      <div class="hint">← → to choose · Enter to confirm · Esc to cancel</div>`;
    this.root.appendChild(modal);

    const cards = [...modal.querySelectorAll<HTMLButtonElement>(".mode-card")];
    const close = () => modal.remove();
    // The Enter press that opened the modal (e.g. in the name field) would
    // otherwise activate the freshly-focused card in the same keystroke.
    const openedAt = performance.now();
    for (const card of cards) {
      card.onclick = () => {
        if (performance.now() - openedAt < 250) return;
        close();
        onPick(card.dataset.mode as InputMode);
      };
    }
    // Keys are handled here and stopped so the game's window-level listeners
    // never see arrows/Space while the modal is open.
    modal.addEventListener("keydown", (e) => {
      const focused = cards.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const back = e.key === "ArrowLeft" || e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey);
        cards[(focused + (back ? cards.length - 1 : 1)) % cards.length].focus();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        close();
        onCancel();
      } else if (e.key === "Enter" || e.key === " ") {
        e.stopPropagation(); // let the focused button's native activation fire
      }
    });
    cards[current === "keyboard" ? 1 : 0].focus();
  }

  /**
   * Full settings modal (opened by the menu gear): input scheme, audio
   * volume/mute, and render quality. Live-applies each change; Esc closes.
   */
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
  }) {
    const modal = document.createElement("div");
    modal.className = "mode-modal";
    modal.tabIndex = -1;
    const qualities: Quality[] = ["low", "medium", "high"];
    modal.innerHTML = `
      <h2>SETTINGS</h2>
      ${
        isTouchDevice()
          ? ""
          : `<div class="settings-section"><div class="hint">controls</div>
        <div class="mode-cards">${modeCard("pointer")}${modeCard("keyboard")}</div></div>`
      }
      <div class="settings-section"><div class="hint">audio</div>
        <label class="settings-row"><span>sfx volume</span>
          <input id="set-vol" type="range" min="0" max="100" value="${Math.round(opts.volume * 100)}" /></label>
        <label class="settings-row"><span>sfx mute</span>
          <input id="set-mute" type="checkbox" ${opts.muted ? "checked" : ""} /></label>
        <label class="settings-row"><span>music volume</span>
          <input id="set-mvol" type="range" min="0" max="100" value="${Math.round(opts.musicVolume * 100)}" /></label>
        <label class="settings-row"><span>music mute</span>
          <input id="set-mmute" type="checkbox" ${opts.musicMuted ? "checked" : ""} /></label>
      </div>
      <div class="settings-section"><div class="hint">quality</div>
        <div class="quality-cards">${qualities
          .map(
            (q) =>
              `<button class="q-btn ${q === opts.quality ? "active" : ""}" data-q="${q}">${q}</button>`,
          )
          .join("")}</div>
      </div>
      <div class="hint">Esc to close</div>`;
    this.root.appendChild(modal);
    const close = () => modal.remove();

    for (const card of modal.querySelectorAll<HTMLButtonElement>(".mode-card")) {
      card.onclick = () => {
        opts.onPickMode(card.dataset.mode as InputMode);
        close();
      };
    }
    const vol = modal.querySelector<HTMLInputElement>("#set-vol")!;
    vol.oninput = () => opts.onVolume(Number(vol.value) / 100);
    const mute = modal.querySelector<HTMLInputElement>("#set-mute")!;
    mute.onchange = () => opts.onMuted(mute.checked);
    const mvol = modal.querySelector<HTMLInputElement>("#set-mvol")!;
    mvol.oninput = () => opts.onMusicVolume(Number(mvol.value) / 100);
    const mmute = modal.querySelector<HTMLInputElement>("#set-mmute")!;
    mmute.onchange = () => opts.onMusicMuted(mmute.checked);
    for (const b of modal.querySelectorAll<HTMLButtonElement>(".q-btn")) {
      b.onclick = () => {
        opts.onQuality(b.dataset.q as Quality);
        modal.querySelectorAll(".q-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      };
    }
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    });
    modal.focus();
  }

  showConnecting() {
    this.root.innerHTML = `<div class="menu"><h1>SMASHZONE</h1><div>connecting…</div></div>`;
  }

  buildHud(code: string) {
    this.root.innerHTML = `
      <div id="h-flash"></div>
      <div class="hud-room">ROOM ${esc(code)} · <span id="h-ping"></span></div>
      <div class="hud-scores" id="h-scores"></div>
      <div class="hud-feed" id="h-feed"></div>
      <div class="hud-damage" id="h-damage"></div>
      <div class="hud-powerup" id="h-powerup"></div>
      <div class="hud-combo" id="h-combo"></div>
      <div class="hud-center" id="h-center"><div id="h-title"></div><div class="hud-sub" id="h-sub"></div></div>
      <div id="h-overlay"></div>
      ${isTouchDevice() ? "" : `<div class="controls-hint">${hudControlsHint()}</div>`}`;
    this.hudDamage = document.getElementById("h-damage");
    this.hudCenter = document.getElementById("h-title");
    this.hudSub = document.getElementById("h-sub");
    this.hudScores = document.getElementById("h-scores");
    this.overlay = document.getElementById("h-overlay");
    this.hudCombo = document.getElementById("h-combo");
    this.hudFlash = document.getElementById("h-flash");
    this.lastCenter = "";
    this.lastDmg = -1;
    this.lastWins.clear();
  }

  /** Combo readout ("N HITS"); hidden below 2 hits. Display-only. */
  setCombo(n: number) {
    if (!this.hudCombo) return;
    if (n < 2) {
      this.hudCombo.textContent = "";
      return;
    }
    this.hudCombo.textContent = `${n} HITS`;
    retrigger(this.hudCombo, "combo-pop");
  }

  /** Full-screen white flash (KO punctuation). */
  flash(strength = 0.4) {
    if (!this.hudFlash) return;
    this.hudFlash.style.setProperty("--flash", String(strength));
    retrigger(this.hudFlash, "flash-out");
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

  /** Append a kill-feed line (caller pre-escapes any names). Cap 4, TTL 4 s. */
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

  setDamage(dmg: number, alive: boolean) {
    if (!this.hudDamage) return;
    this.hudDamage.textContent = alive ? `${dmg}%` : "";
    const heat = Math.min(1, dmg / 150);
    this.hudDamage.style.color = `rgb(255, ${Math.round(255 - heat * 190)}, ${Math.round(
      255 - heat * 230,
    )})`;
    // Pop on increase only (this runs every frame).
    if (alive && this.lastDmg >= 0 && dmg > this.lastDmg) {
      retrigger(this.hudDamage, "dmg-pop");
    }
    this.lastDmg = alive ? dmg : -1;
  }

  setCenter(title: string, sub = "") {
    // Slam-in only when the text actually changes — this is called every
    // frame during countdown with the same string.
    if (this.hudCenter && title !== this.lastCenter) {
      this.lastCenter = title;
      this.hudCenter.textContent = title;
      if (title) retrigger(this.hudCenter, "center-pop");
    }
    if (this.hudSub) this.hudSub.textContent = sub;
  }

  setScores(
    metas: Map<number, PlayerMeta>,
    scores: Score[],
    aliveIds?: Set<number>,
    disconnectedIds?: Set<number>,
  ) {
    if (!this.hudScores) return;
    const wins = new Map(scores.map((s) => [s.id, s.wins]));
    this.hudScores.innerHTML = [...metas.values()]
      .map((m) => {
        const dead = aliveIds && !aliveIds.has(m.id);
        const gone = disconnectedIds?.has(m.id);
        const w = wins.get(m.id) ?? 0;
        // Bump the row once when its win count goes up (round win).
        const bump = w > (this.lastWins.get(m.id) ?? 0);
        this.lastWins.set(m.id, w);
        return `<div class="row ${dead ? "dead" : ""} ${gone ? "disconnected" : ""} ${bump ? "bump" : ""}">
          <div class="dot" style="background:${colorOf(m.slot)}"></div>
          <span>${esc(m.name)}${gone ? " ⟳" : ""}</span><b>${w}</b>
        </div>`;
      })
      .join("");
  }

  /** Full-screen overlays for lobby / match end. */
  setPhaseOverlay(phase: Phase, ctx: PhaseCtx) {
    if (!this.overlay) return;
    if (phase.type === "Lobby") {
      const isHost = ctx.myId === ctx.host;
      const canAddBot = isHost && ctx.metas.size < constants.maxPlayers;
      this.overlay.innerHTML = `
        <div class="lobby-panel">
          <div class="hint">share this code</div>
          <div class="code">${esc(ctx.code)}</div>
          <div class="players">${[...ctx.metas.values()]
            .map((m) => {
              // Difficulty names are our own constants, not wire text.
              const tag = m.bot
                ? `<span class="bot-tag diff-${m.difficulty}">BOT · ${
                    BOT_DIFF_NAMES[m.difficulty] ?? "?"
                  }</span>`
                : "";
              const star = m.id === ctx.host ? " ★" : "";
              const rm =
                isHost && m.bot
                  ? `<button class="bot-x" data-bot="${m.id}" aria-label="remove bot">✕</button>`
                  : "";
              return `<div class="pcard" style="--slot:${colorOf(m.slot)}">${esc(m.name)}${tag}${star}${rm}</div>`;
            })
            .join("")}</div>
          ${
            isHost
              ? `<button id="h-start" class="big-btn">START MATCH</button>`
              : `<div class="hint">waiting for the host to start…</div>`
          }
          ${
            canAddBot
              ? `<div class="addbot-row"><span class="hint">+ add bot</span>${BOT_DIFF_NAMES.map(
                  (n, i) =>
                    // Keep #h-addbot on Medium: it stays the "default" add-bot
                    // hook for tooling and muscle memory.
                    `<button class="bot-add diff-${i}" data-diff="${i}"${
                      i === 1 ? ` id="h-addbot"` : ""
                    }>${n}</button>`,
                ).join("")}</div>`
              : ""
          }
          <div class="hint">you can run around and brawl while you wait — falling off just respawns you</div>
        </div>`;
      const btn = document.getElementById("h-start");
      if (btn) btn.onclick = ctx.onStart;
      for (const b of this.overlay.querySelectorAll<HTMLButtonElement>(".bot-add")) {
        b.onclick = () => ctx.onAddBot(Number(b.dataset.diff));
      }
      for (const x of this.overlay.querySelectorAll<HTMLButtonElement>(".bot-x")) {
        x.onclick = () => ctx.onRemoveBot(Number(x.dataset.bot));
      }
    } else if (phase.type === "MatchEnd") {
      const isHost = ctx.myId === ctx.host;
      const winner = ctx.metas.get(phase.winner);
      this.overlay.innerHTML = `
        <div class="lobby-panel">
          <div class="code" style="letter-spacing:2px">${esc(winner?.name ?? "???")} WINS!</div>
          <div class="players">${phase.scores
            .map((s) => {
              const m = ctx.metas.get(s.id);
              return `<div class="pcard" style="--slot:${colorOf(m?.slot ?? 0)}">${
                esc(m?.name ?? "?")
              }<br><b style="font-size:26px">${s.wins}</b></div>`;
            })
            .join("")}</div>
          <div class="row" style="justify-content:center">
            ${
              ctx.onWatchReplay
                ? `<button id="h-replay" class="big-btn secondary">WATCH REPLAY</button>`
                : ""
            }
            ${
              isHost
                ? `<button id="h-rematch" class="big-btn">REMATCH</button>`
                : ""
            }
          </div>
          ${isHost ? "" : `<div class="hint">waiting for the host…</div>`}
        </div>`;
      const btn = document.getElementById("h-rematch");
      if (btn) btn.onclick = ctx.onRematch;
      const replayBtn = document.getElementById("h-replay");
      if (replayBtn && ctx.onWatchReplay) replayBtn.onclick = ctx.onWatchReplay;
    } else {
      this.overlay.innerHTML = "";
    }
  }
}
