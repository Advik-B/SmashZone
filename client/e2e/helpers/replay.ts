// Typed access to the replay dev hooks (window.__replayStore / window.__replay)
// shared by the replay specs.
import type { Page } from "playwright";

export interface StoredReplay {
  id: string;
  pinned: boolean;
  sizeBytes: number;
  savedAt: number;
  header: {
    partial: boolean;
    joinedMidMatch: boolean;
    code: string;
    buildId: string;
    localPlayerId: number;
    startTick: number;
    endTick: number;
    players: { id: number; name: string }[];
    result: { winner: number } | null;
    rounds: { round: number; endTick: number | null }[];
    markers: { kind: string; player: number; other: number; tick: number }[];
  };
}

export function listReplays(page: Page): Promise<StoredReplay[]> {
  return page.evaluate(() =>
    (window as any).__replayStore.listReplays(),
  ) as Promise<StoredReplay[]>;
}

/** Wait until the library holds exactly n replays (finalize/save is async). */
export async function waitReplayCount(page: Page, n: number): Promise<StoredReplay[]> {
  await page.waitForFunction(
    async (want) => {
      const list = await (window as any).__replayStore.listReplays();
      return list.length === want;
    },
    n,
    { timeout: 15_000, polling: 250 },
  );
  return listReplays(page);
}

export interface ReplayState {
  playhead: number;
  playing: boolean;
  speed: number;
  start: number;
  end: number;
  follow: number;
}

/** Snapshot of the active viewer's transport state (window.__replay). */
export function replayState(page: Page): Promise<ReplayState> {
  return page.evaluate(() => {
    const r = (window as any).__replay;
    return {
      playhead: r.playheadTick,
      playing: r.isPlaying,
      speed: r.playbackSpeed,
      start: r.dataset.startTick,
      end: r.dataset.endTick,
      follow: r.followTargetId,
    };
  }) as Promise<ReplayState>;
}

/** Position of a player's mesh inside the replay viewer's renderer. */
export function replayPlayerPos(
  page: Page,
  id: number,
): Promise<{ x: number; y: number; z: number } | null> {
  return page.evaluate((pid) => {
    const p = (window as any).__replay.renderer.playerPos(pid);
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }, id) as Promise<{ x: number; y: number; z: number } | null>;
}
