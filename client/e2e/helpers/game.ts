// Page-level driver for SmashZone: opens tuned browser contexts and exposes
// the game's built-in automation hooks (window.__gc / window.__input, the
// stable DOM ids in ui.ts) as typed helpers so specs never hand-roll them.
import type { BrowserContext, Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getBrowser } from "./browser";
import { baseUrl } from "./http";

export interface GamePageOpts {
  /** Pre-seed the player name (localStorage sz-name). */
  name?: string;
  /**
   * Input scheme seeded into localStorage. Defaults to "keyboard" so the
   * first-join prompt never appears; pass null to leave it unset (for the
   * spec that tests the prompt itself).
   */
  inputMode?: "keyboard" | "pointer" | null;
  /** Emulate a touch device (shows the on-screen controls). */
  touch?: boolean;
  /** Skip the audio-mute seeding (for the settings-persistence spec). */
  seedAudio?: boolean;
}

export interface GamePage {
  page: Page;
  ctx: BrowserContext;
  /** Uncaught page errors collected since open (should stay empty). */
  errors: string[];
}

const ARTIFACTS_DIR = join(import.meta.dir, "..", ".artifacts");

// Contexts opened via newGamePage, so specs can close them all in afterEach
// (keeps ≤ a few live pages at once — SwiftShader rendering is CPU-bound).
const openContexts = new Set<BrowserContext>();

/** Close every context opened via newGamePage (call in afterEach). */
export async function closeGamePages(): Promise<void> {
  const ctxs = [...openContexts];
  openContexts.clear();
  await Promise.all(ctxs.map((c) => c.close().catch(() => {})));
}

/** Open a context + page tuned for headless testing and load the menu. */
export async function newGamePage(opts: GamePageOpts = {}): Promise<GamePage> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    baseURL: baseUrl(),
    viewport: { width: 1280, height: 720 },
    ...(opts.touch ? { hasTouch: true, isMobile: true } : {}),
  });
  const seed = {
    inputMode: opts.inputMode === undefined ? "keyboard" : opts.inputMode,
    name: opts.name ?? null,
    seedAudio: opts.seedAudio ?? true,
  };
  await ctx.addInitScript((s) => {
    // Lowest quality: SwiftShader is CPU-bound and tests only read state.
    localStorage.setItem("sz-quality", "low");
    if (s.inputMode) localStorage.setItem("sz-input-mode", s.inputMode);
    if (s.name !== null) localStorage.setItem("sz-name", s.name);
    if (s.seedAudio) {
      localStorage.setItem("sz-muted", "1");
      localStorage.setItem("sz-music-muted", "1");
    }
  }, seed);
  if (opts.touch) {
    // The client keys "is this a touch device?" off `matchMedia("(pointer:
    // coarse)")`; make that unambiguously true so the on-screen controls show.
    await ctx.addInitScript(() => {
      const orig = window.matchMedia.bind(window);
      window.matchMedia = (q: string) =>
        q.includes("pointer: coarse") ? ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as unknown as MediaQueryList) : orig(q);
    });
  }
  openContexts.add(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto("/");
  // Menu appears once WASM + character model + audio finish loading.
  await page.waitForSelector("#m-create", { timeout: 30_000 });
  return { page, ctx, errors };
}

export async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS_DIR, `${name}.png`) });
}

// ---- menu / lobby ----

/** Create a party from the menu; resolves with the 4-char room code. */
export async function createRoom(page: Page, name: string): Promise<string> {
  await page.fill("#m-name", name);
  await page.click("#m-create");
  const room = await page.waitForSelector(".hud-room", { timeout: 20_000 });
  const text = (await room.textContent()) ?? "";
  const code = /ROOM ([A-Z0-9]{4})/.exec(text)?.[1];
  if (!code) throw new Error(`no room code in HUD text: "${text}"`);
  return code;
}

export async function joinRoom(page: Page, code: string, name: string): Promise<void> {
  await page.fill("#m-name", name);
  await page.fill("#m-code", code);
  await page.click("#m-join");
  await page.waitForSelector(".hud-room", { timeout: 20_000 });
}

/** The menu's error line (non-empty after a failed create/join). */
export async function menuError(page: Page): Promise<string> {
  await page.waitForFunction(
    () => (document.querySelector(".menu .error")?.textContent ?? "") !== "",
    undefined,
    { timeout: 20_000 },
  );
  return (await page.textContent(".menu .error")) ?? "";
}

/** Add a bot from the lobby. 0=EASY 1=MEDIUM 2=HARD 3=EXPERT 4=IMPOSSIBLE. */
export async function addBot(page: Page, difficulty: number): Promise<void> {
  const before = await page.locator(".pcard").count();
  await page.click(`.bot-add[data-diff="${difficulty}"]`);
  await page.waitForFunction(
    (n) => document.querySelectorAll(".pcard").length > n,
    before,
    { timeout: 10_000 },
  );
}

export async function startMatch(page: Page): Promise<void> {
  await page.click("#h-start");
}

// ---- game-state hooks (window.__gc / window.__input) ----

export interface PhaseInfo {
  type: "Lobby" | "Countdown" | "Playing" | "RoundEnd" | "MatchEnd";
  winner?: number | null;
  scores?: { id: number; wins: number }[];
  round?: number;
  host?: number;
}

export function phase(page: Page): Promise<PhaseInfo> {
  return page.evaluate(() => (window as any).__gc.phase) as Promise<PhaseInfo>;
}

export async function waitPhase(
  page: Page,
  type: PhaseInfo["type"],
  timeout = 30_000,
): Promise<PhaseInfo> {
  await page.waitForFunction(
    (t) => (window as any).__gc?.phase?.type === t,
    type,
    { timeout, polling: 100 },
  );
  return phase(page);
}

export function myId(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__gc.myId) as Promise<number>;
}

export function aliveIds(page: Page): Promise<number[]> {
  return page.evaluate(() => [...(window as any).__gc.aliveIds]) as Promise<number[]>;
}

export interface Pos {
  x: number;
  y: number;
  z: number;
}

export function playerPos(page: Page, id: number): Promise<Pos | null> {
  return page.evaluate((pid) => {
    const p = (window as any).__gc.renderer.playerPos(pid);
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }, id) as Promise<Pos | null>;
}

export async function myPos(page: Page): Promise<Pos> {
  const p = await playerPos(page, await myId(page));
  if (!p) throw new Error("local player has no render position yet");
  return p;
}

// ---- event recording ----

/**
 * Start recording every GameEvent the client processes (server snapshot
 * events: Hit, Death, TileWarn, PickupSpawn, …) into window.__events by
 * shadowing gc.onEvent on the instance. Idempotent; survives reconnects
 * (the GameClient instance persists across a re-Welcome).
 */
export async function recordEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    const gc = w.__gc;
    if (!gc) throw new Error("no __gc yet — join a room first");
    if (gc.__recording) return;
    gc.__recording = true;
    w.__events = [];
    const orig = gc.onEvent.bind(gc);
    gc.onEvent = (ev: unknown) => {
      orig(ev);
      w.__events.push(ev);
    };
  });
}

/** Drop already-recorded events (keeps recording active). Use between rounds
 *  so a wait for "the next Death" doesn't match a previous round's event. */
export function clearEvents(page: Page): Promise<void> {
  return page.evaluate(() => {
    (window as any).__events = [];
  }) as Promise<void>;
}

export function events(page: Page, type?: string): Promise<any[]> {
  return page.evaluate((t) => {
    const evs = ((window as any).__events ?? []) as any[];
    return t ? evs.filter((e) => e.type === t) : evs;
  }, type ?? null) as Promise<any[]>;
}

/**
 * Wait for a recorded event of `type` whose fields shallow-match `match`,
 * and return the first one.
 */
export async function waitEvent(
  page: Page,
  type: string,
  match: Record<string, unknown> = {},
  timeout = 30_000,
): Promise<any> {
  await page.waitForFunction(
    ({ type, match }) => {
      const evs = ((window as any).__events ?? []) as any[];
      return evs.some(
        (e) =>
          e.type === type &&
          Object.entries(match).every(([k, v]) => JSON.stringify(e[k]) === JSON.stringify(v)),
      );
    },
    { type, match },
    { timeout, polling: 100 },
  );
  const all = await events(page, type);
  return all.find((e) =>
    Object.entries(match).every(([k, v]) => JSON.stringify(e[k]) === JSON.stringify(v)),
  );
}

// ---- movement / steering ----

/** Point the camera (and therefore W-forward) at an absolute yaw. */
export function setYaw(page: Page, yaw: number): Promise<void> {
  return page.evaluate((y) => {
    (window as any).__input.camYaw = y;
  }, yaw) as Promise<void>;
}

/** Face toward a world-space point (forward = (sin yaw, cos yaw)). */
export async function faceToward(page: Page, x: number, z: number): Promise<void> {
  const p = await myPos(page);
  await setYaw(page, Math.atan2(x - p.x, z - p.z));
}

export async function walk(page: Page, ms: number): Promise<void> {
  await page.keyboard.down("w");
  await page.waitForTimeout(ms);
  await page.keyboard.up("w");
}

/**
 * Walk toward another player and stop within `stopDist` (the verify-skill
 * rule: stop before attacking or you shove the target out of reach).
 */
export async function approach(
  page: Page,
  targetId: number,
  stopDist = 1.3,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const me = await myPos(page);
      const target = await playerPos(page, targetId);
      if (!target) throw new Error(`no position for player ${targetId}`);
      const dist = Math.hypot(target.x - me.x, target.z - me.z);
      if (dist <= stopDist) return;
      await setYaw(page, Math.atan2(target.x - me.x, target.z - me.z));
      // Pulse forward in short bursts and re-measure. Holding `w` continuously
      // overshoots the target between position samples (~1.4 u at 8 u/s), so we
      // oscillate and never land inside stopDist; short hops converge cleanly
      // and leave us stopped (good facing for the follow-up swing). Scale the
      // hop down as we close in.
      const hopMs = dist > 3 ? 120 : dist > 1.8 ? 70 : 45;
      await page.keyboard.down("w");
      await page.waitForTimeout(hopMs);
      await page.keyboard.up("w");
      await page.waitForTimeout(40); // let velocity bleed before re-measuring
    }
    throw new Error("approach timed out");
  } finally {
    await page.keyboard.up("w");
  }
}

/** Pulse-walk to the arena center (origin) so knockbacks stay on the platform. */
export async function walkToCenter(page: Page, within = 2.2): Promise<void> {
  const deadline = Date.now() + 8_000;
  try {
    while (Date.now() < deadline) {
      const me = await myPos(page);
      if (Math.hypot(me.x, me.z) <= within) return;
      await setYaw(page, Math.atan2(-me.x, -me.z));
      await page.keyboard.down("w");
      await page.waitForTimeout(60);
      await page.keyboard.up("w");
      await page.waitForTimeout(40);
    }
  } finally {
    await page.keyboard.up("w");
  }
}

/** Tap an attack/movement key for one press. */
export async function tap(page: Page, key: string, holdMs = 60): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
}

/**
 * Walk radially outward until falling off the arena; resolves once the local
 * player's Death event arrives. Requires recordEvents() to be active.
 */
export async function walkOffEdge(page: Page): Promise<void> {
  const id = await myId(page);
  const start = await myPos(page);
  // Radial outward from arena center; from dead center any direction works.
  const yaw =
    Math.hypot(start.x, start.z) > 0.3 ? Math.atan2(start.x, start.z) : Math.PI / 4;
  await setYaw(page, yaw);
  await page.keyboard.down("w");
  try {
    await waitEvent(page, "Death", { player: id }, 20_000);
  } finally {
    await page.keyboard.up("w");
  }
}

/**
 * Deterministic round outcome with zero combat RNG: `loser` walks off the
 * edge; every page then sees RoundEnd (or MatchEnd when the winner already
 * has roundsToWin-1 wins). Returns the loser page's end phase.
 */
export async function suicideRound(loser: Page, all: Page[]): Promise<PhaseInfo> {
  for (const p of all) await waitPhase(p, "Playing", 40_000);
  await recordEvents(loser);
  await clearEvents(loser); // don't match a previous round's Death
  await walkOffEdge(loser);
  await Promise.all(
    all.map((p) =>
      p.waitForFunction(
        () => ["RoundEnd", "MatchEnd"].includes((window as any).__gc?.phase?.type),
        undefined,
        { timeout: 20_000, polling: 100 },
      ),
    ),
  );
  return phase(loser);
}

// ---- misc HUD readers ----

export async function hudText(page: Page, selector: string): Promise<string> {
  return (await page.textContent(selector)) ?? "";
}

/** Scoreboard rows as {name, wins, dead, disconnected}. */
export function scoreRows(
  page: Page,
): Promise<{ name: string; wins: number; dead: boolean; disconnected: boolean }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("#h-scores .row")].map((r) => ({
      name: r.querySelector("span")?.textContent ?? "",
      wins: Number(r.querySelector("b")?.textContent ?? "-1"),
      dead: r.classList.contains("dead"),
      disconnected: r.classList.contains("disconnected"),
    })),
  ) as Promise<{ name: string; wins: number; dead: boolean; disconnected: boolean }[]>;
}
