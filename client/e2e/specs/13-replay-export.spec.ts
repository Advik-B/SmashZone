// Video export: a short range renders offline through WebCodecs into an MP4
// (H.264 or VP9-in-MP4 depending on what headless Chromium can encode), or
// falls back to realtime WebM. Asserts a playable-sized blob comes out and
// the viewer transport survives the round trip.
import { afterEach, describe, expect, test } from "bun:test";
import {
  closeGamePages,
  createRoom,
  joinRoom,
  newGamePage,
  startMatch,
  suicideRound,
} from "../helpers/game";
import { replayState, waitReplayCount } from "../helpers/replay";

afterEach(closeGamePages);

describe("replay video export", () => {
  test("a 2s clip exports to mp4 (or webm fallback) and restores the viewer", async () => {
    const host = await newGamePage({ name: "Alpha" });
    const loser = await newGamePage({ name: "Bravo" });
    const code = await createRoom(host.page, "Alpha");
    await joinRoom(loser.page, code, "Bravo");
    await host.page.waitForFunction(
      () => document.querySelectorAll(".pcard").length === 2,
      undefined,
      { timeout: 15_000 },
    );
    await startMatch(host.page);
    await suicideRound(loser.page, [host.page, loser.page]);
    await host.page.waitForTimeout(500);
    await host.page.evaluate(() => (window as any).__gc.destroy());
    await waitReplayCount(host.page, 1);

    await host.page.goto("/");
    await host.page.waitForSelector("#m-create", { timeout: 30_000 });
    await host.page.click("#m-replays");
    await host.page.waitForSelector(".rl-row", { timeout: 10_000 });
    await host.page.click(".rl-watch");
    await host.page.waitForSelector(".rv-bar", { timeout: 15_000 });

    // Drive the export through the same API the dialog uses. 2 s at 720p30
    // keeps SwiftShader render time sane.
    const res = (await host.page.evaluate(async () => {
      const r = (window as any).__replay;
      const start = r.dataset.startTick;
      const end = Math.min(start + 120, r.dataset.endTick);
      const mode = typeof VideoEncoder !== "undefined" ? "mp4" : "webm";
      const preSeek = r.playheadTick;
      const handle = await r.startExport({
        width: 1280,
        height: 720,
        fps: 30,
        camera: "follow",
        targetId: r.followTargetId,
        startTick: start,
        endTick: end,
        mode,
      });
      const blob = await handle.done;
      const head = Array.from(new Uint8Array(await blob.slice(0, 12).arrayBuffer()));
      return {
        size: blob.size,
        type: blob.type,
        mode,
        head,
        exporting: r.isExporting,
        playheadRestored: Math.abs(r.playheadTick - preSeek) < 1,
        lastExport: r.lastExport,
      };
    })) as {
      size: number;
      type: string;
      mode: string;
      head: number[];
      exporting: boolean;
      playheadRestored: boolean;
      lastExport: { size: number; type: string } | null;
    };

    console.log(`[13-export] mode=${res.mode} type=${res.type} size=${res.size}`);
    expect(res.size).toBeGreaterThan(20_000);
    expect(["video/mp4", "video/webm"]).toContain(res.type);
    if (res.type === "video/mp4") {
      // ISO-BMFF: "ftyp" box name at bytes 4..8.
      expect(String.fromCharCode(...res.head.slice(4, 8))).toBe("ftyp");
    } else {
      // Matroska/WebM EBML magic.
      expect(res.head.slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    }
    expect(res.exporting).toBe(false);
    expect(res.playheadRestored).toBe(true);
    expect(res.lastExport?.size).toBe(res.size);

    // The viewer still works after the export (canvas restored, transport ok).
    await host.page.evaluate(() => (window as any).__replay.play());
    await host.page.waitForTimeout(400);
    const st = await replayState(host.page);
    expect(st.playhead).toBeGreaterThan(st.start);

    expect(host.errors).toEqual([]);
  }, 170_000);
});
