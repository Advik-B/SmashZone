// Replay playback: library -> viewer, world reconstruction from recorded
// snapshots, seeking (forward + backward), KO markers, the event-driven
// kill feed, playback speed and end-of-replay auto-pause.
import { afterEach, describe, expect, test } from "bun:test";
import {
  closeGamePages,
  createRoom,
  joinRoom,
  myId,
  newGamePage,
  screenshot,
  startMatch,
  suicideRound,
} from "../helpers/game";
import { replayPlayerPos, replayState, waitReplayCount } from "../helpers/replay";

afterEach(closeGamePages);

describe("replay playback", () => {
  test("a recorded round plays back with seeking, markers and killfeed", async () => {
    const host = await newGamePage({ name: "Alpha" });
    const loser = await newGamePage({ name: "Bravo" });
    const code = await createRoom(host.page, "Alpha");
    await joinRoom(loser.page, code, "Bravo");
    await host.page.waitForFunction(
      () => document.querySelectorAll(".pcard").length === 2,
      undefined,
      { timeout: 15_000 },
    );
    const alphaId = await myId(host.page);
    const bravoId = await myId(loser.page);
    await startMatch(host.page);

    // One decided round is plenty of material; leaving right after gives a
    // partial replay (which must play back just like a finished one).
    await suicideRound(loser.page, [host.page, loser.page]);
    await host.page.waitForTimeout(500);
    await host.page.evaluate(() => (window as any).__gc.destroy());
    const [rep] = await waitReplayCount(host.page, 1);
    const kos = rep.header.markers.filter((m) => m.kind === "ko");
    expect(kos.length).toBe(1);
    expect(kos[0].player).toBe(bravoId);
    const koTick = kos[0].tick;

    // Fresh boot -> menu -> library -> watch.
    await host.page.goto("/");
    await host.page.waitForSelector("#m-create", { timeout: 30_000 });
    await host.page.click("#m-replays");
    await host.page.waitForSelector(".rl-row", { timeout: 10_000 });
    expect(await host.page.locator(".rl-row").count()).toBe(1);
    await host.page.click(".rl-watch");
    await host.page.waitForSelector(".rv-bar", { timeout: 15_000 });

    // Auto-plays from the start, following the recording player.
    let st = await replayState(host.page);
    expect(st.playing).toBe(true);
    expect(st.follow).toBe(alphaId);
    expect(await replayPlayerPos(host.page, alphaId)).not.toBeNull();
    expect(await replayPlayerPos(host.page, bravoId)).not.toBeNull();

    // The KO marker rendered on the timeline.
    expect(await host.page.locator(".rv-marker.mk-ko").count()).toBe(1);
    await screenshot(host.page, "replay-viewer");

    // Seek just before the KO — Bravo is mid-walk/mid-fall there — and check
    // both the transport (playhead advances) and the world (mesh moves).
    await host.page.evaluate((t) => {
      const r = (window as any).__replay;
      r.pause();
      r.seek(t);
    }, koTick - 45);
    st = await replayState(host.page);
    expect(Math.abs(st.playhead - (koTick - 45))).toBeLessThan(1);
    await host.page.evaluate(() => (window as any).__replay.play());
    const before = await replayPlayerPos(host.page, bravoId);
    await host.page.waitForTimeout(900);
    const after = await replayPlayerPos(host.page, bravoId);
    const st2 = await replayState(host.page);
    // Transport ran: strictly past the seek point (it may legitimately have
    // clamped at endTick, which sits shortly after the KO in this recording).
    expect(st2.playhead).toBeGreaterThan(st.playhead);
    const moved = Math.hypot(
      after!.x - before!.x,
      after!.y - before!.y,
      after!.z - before!.z,
    );
    expect(moved).toBeGreaterThan(0.05);

    // Crossing the Death event during playback feeds the kill feed.
    await host.page.waitForFunction(
      () => document.querySelectorAll("#h-feed .feed-line").length > 0,
      undefined,
      { timeout: 15_000, polling: 100 },
    );

    // Seeking backward rebuilds silently: playhead lands, feed clears, and
    // no crossed events re-fire while paused.
    await host.page.evaluate(() => {
      const r = (window as any).__replay;
      r.pause();
      r.seek(r.dataset.startTick);
    });
    st = await replayState(host.page);
    expect(st.playing).toBe(false);
    expect(Math.abs(st.playhead - st.start)).toBeLessThan(1);
    expect(await host.page.locator("#h-feed .feed-line").count()).toBe(0);

    // 4x speed runs to the end and auto-pauses there.
    await host.page.evaluate(() => {
      const r = (window as any).__replay;
      r.seek(r.dataset.endTick - 240);
      r.setSpeed(4);
      r.play();
    });
    await host.page.waitForFunction(
      () => {
        const r = (window as any).__replay;
        return !r.isPlaying && r.playheadTick >= r.dataset.endTick - 1;
      },
      undefined,
      { timeout: 15_000, polling: 100 },
    );

    // Snapshot stepping stays paused and moves the playhead.
    await host.page.evaluate(() => (window as any).__replay.stepSnapshots(-1));
    st = await replayState(host.page);
    expect(st.playing).toBe(false);
    expect(st.playhead).toBeLessThan(st.end);

    // Back to the library.
    await host.page.click("#rv-back");
    await host.page.waitForSelector(".rl-list", { timeout: 10_000 });

    // The whole ride must not have thrown anything in-page.
    expect(host.errors).toEqual([]);
  }, 150_000);
});
