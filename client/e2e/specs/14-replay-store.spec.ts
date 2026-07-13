// Replay library storage behaviors, driven through the real IndexedDB via
// the window.__replayStore hook (no matches needed): retention cap with
// pinning, delete, and corrupt-import rejection.
import { afterEach, describe, expect, test } from "bun:test";
import { closeGamePages, newGamePage } from "../helpers/game";

afterEach(closeGamePages);

describe("replay store", () => {
  test("keeps the newest 10 unpinned replays; pinned ones never age out", async () => {
    const { page } = await newGamePage({ name: "Alpha" });

    const result = (await page.evaluate(async () => {
      const store = (window as any).__replayStore;
      const mkHeader = (n: number) => ({
        format: "szr",
        version: 1,
        buildId: "test",
        createdAt: new Date(2026, 0, 1, 0, n).toISOString(),
        code: `T${String(n).padStart(3, "0")}`,
        localPlayerId: 0,
        players: [{ id: 0, name: "Alpha", slot: 0, bot: false, difficulty: 0 }],
        startTick: 0,
        endTick: 600,
        tickRate: 60,
        snapshotDivisor: 3,
        partial: false,
        joinedMidMatch: false,
        compression: "none",
        result: null,
        rounds: [],
        markers: [],
      });
      const ids: string[] = [];
      for (let n = 0; n < 3; n++) {
        ids.push(await store.saveReplay(mkHeader(n), new Blob([`r${n}`])));
        // savedAt is Date.now(); keep insertion order distinct.
        await new Promise((r) => setTimeout(r, 5));
      }
      // Pin the oldest, then flood past the cap.
      await store.setPinned(ids[0], true);
      for (let n = 3; n < 14; n++) {
        ids.push(await store.saveReplay(mkHeader(n), new Blob([`r${n}`])));
        await new Promise((r) => setTimeout(r, 5));
      }
      const list = await store.listReplays();
      return {
        count: list.length,
        pinnedSurvived: list.some((m: any) => m.id === ids[0]),
        oldestUnpinnedGone: !list.some((m: any) => m.id === ids[1]),
        unpinnedCount: list.filter((m: any) => !m.pinned).length,
        blobOfPinned: (await store.getReplayBlob(ids[0])) !== null,
      };
    })) as {
      count: number;
      pinnedSurvived: boolean;
      oldestUnpinnedGone: boolean;
      unpinnedCount: number;
      blobOfPinned: boolean;
    };

    expect(result.unpinnedCount).toBe(10); // MAX_REPLAYS
    expect(result.count).toBe(11); // + the pinned one
    expect(result.pinnedSurvived).toBe(true);
    expect(result.oldestUnpinnedGone).toBe(true);
    expect(result.blobOfPinned).toBe(true);
  }, 60_000);

  test("delete removes meta+blob; corrupt imports are rejected", async () => {
    const { page } = await newGamePage({ name: "Alpha" });

    const result = (await page.evaluate(async () => {
      const store = (window as any).__replayStore;
      const header = {
        format: "szr",
        version: 1,
        buildId: "test",
        createdAt: new Date().toISOString(),
        code: "TDEL",
        localPlayerId: 0,
        players: [],
        startTick: 0,
        endTick: 60,
        tickRate: 60,
        snapshotDivisor: 3,
        partial: true,
        joinedMidMatch: false,
        compression: "none",
        result: null,
        rounds: [],
        markers: [],
      };
      const id = await store.saveReplay(header, new Blob(["x"]));
      await store.deleteReplay(id);
      const afterDelete = await store.listReplays();
      const blobGone = (await store.getReplayBlob(id)) === null;

      // Garbage bytes: not a replay at all.
      let garbageRejected = false;
      try {
        await store.importReplayFile(new Blob(["definitely not a replay"]));
      } catch {
        garbageRejected = true;
      }
      // Right magic, truncated header: must also fail cleanly.
      let truncatedRejected = false;
      try {
        const bad = new Uint8Array(8);
        bad.set([0x53, 0x5a, 0x52, 0x31]); // "SZR1"
        new DataView(bad.buffer).setUint32(4, 9999, true);
        await store.importReplayFile(new Blob([bad]));
      } catch {
        truncatedRejected = true;
      }
      const finalCount = (await store.listReplays()).length;
      return { afterDelete: afterDelete.length, blobGone, garbageRejected, truncatedRejected, finalCount };
    })) as {
      afterDelete: number;
      blobGone: boolean;
      garbageRejected: boolean;
      truncatedRejected: boolean;
      finalCount: number;
    };

    expect(result.afterDelete).toBe(0);
    expect(result.blobGone).toBe(true);
    expect(result.garbageRejected).toBe(true);
    expect(result.truncatedRejected).toBe(true);
    expect(result.finalCount).toBe(0);
  }, 60_000);
});
