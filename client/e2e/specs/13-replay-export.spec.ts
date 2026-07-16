// Video export: a short range renders offline through WebCodecs into a raw
// elementary stream that ffmpeg-wasm muxes into a constant-frame-rate MP4,
// with an offline-rendered AAC soundtrack when sound is on. Asserts container
// correctness — ftyp magic, a single stts run (uniform frame durations =
// true CFR, the fix for stuttery playback), and the mp4a audio track being
// present/absent per the sound toggle — plus that the viewer transport
// survives the round trip.
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

interface ExportProbe {
  size: number;
  type: string;
  ftyp: string;
  hasAudio: boolean;
  sttsEntries: number;
  codec: string | undefined;
  exporting: boolean;
  playheadRestored: boolean;
  lastExport: { size: number; type: string; codec?: string } | null;
}

describe("replay video export", () => {
  test("2s clips export to CFR mp4 with and without sound; viewer restores", async () => {
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
    // keeps SwiftShader render time sane. startExport is synchronous on
    // purpose (playhead restore) — only its .done promise is awaited.
    const driveExport = (sound: boolean) =>
      host.page.evaluate(async (withSound: boolean) => {
        const r = (window as any).__replay;
        const start = r.dataset.startTick;
        const end = Math.min(start + 120, r.dataset.endTick);
        const preSeek = r.playheadTick;
        const handle = r.startExport({
          width: 1280,
          height: 720,
          fps: 30,
          camera: "follow",
          targetId: r.followTargetId,
          startTick: start,
          endTick: end,
          quality: "standard",
          sound: withSound,
        });
        const blob = await handle.done;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const find = (fourcc: string): number => {
          const t = [...fourcc].map((c) => c.charCodeAt(0));
          outer: for (let i = 0; i + t.length <= bytes.length; i++) {
            for (let j = 0; j < t.length; j++) {
              if (bytes[i + j] !== t[j]) continue outer;
            }
            return i;
          }
          return -1;
        };
        // stts box: [u32 size]["stts"][u8 ver + u24 flags][u32 entry_count].
        // +faststart puts moov before mdat and the video track is written
        // first, so the first hit is the video track's table.
        const stts = find("stts");
        const sttsEntries =
          stts >= 0
            ? ((bytes[stts + 8] << 24) |
                (bytes[stts + 9] << 16) |
                (bytes[stts + 10] << 8) |
                bytes[stts + 11]) >>>
              0
            : -1;
        return {
          size: blob.size,
          type: blob.type,
          ftyp: String.fromCharCode(...bytes.slice(4, 8)),
          hasAudio: find("mp4a") >= 0,
          sttsEntries,
          codec: r.lastExport?.codec,
          exporting: r.isExporting,
          playheadRestored: Math.abs(r.playheadTick - preSeek) < 1,
          lastExport: r.lastExport,
        };
      }, sound) as Promise<ExportProbe>;

    // Sound on: full pipeline — WebCodecs video + offline audio + ffmpeg mux.
    const withSound = await driveExport(true);
    console.log(
      `[13-export] sound=on codec=${withSound.codec} type=${withSound.type} size=${withSound.size} stts=${withSound.sttsEntries}`,
    );
    expect(withSound.type).toBe("video/mp4");
    expect(withSound.ftyp).toBe("ftyp");
    expect(withSound.size).toBeGreaterThan(20_000);
    expect(withSound.hasAudio).toBe(true); // AAC sample entry present
    expect(withSound.sttsEntries).toBe(1); // uniform durations → CFR
    expect(withSound.exporting).toBe(false);
    expect(withSound.playheadRestored).toBe(true);
    expect(withSound.lastExport?.size).toBe(withSound.size);

    // Sound off: -an path, and the second run reuses the warm ffmpeg core.
    const silent = await driveExport(false);
    console.log(
      `[13-export] sound=off codec=${silent.codec} type=${silent.type} size=${silent.size} stts=${silent.sttsEntries}`,
    );
    expect(silent.type).toBe("video/mp4");
    expect(silent.ftyp).toBe("ftyp");
    expect(silent.hasAudio).toBe(false);
    expect(silent.sttsEntries).toBe(1);
    expect(silent.playheadRestored).toBe(true);

    // The viewer still works after the exports (canvas restored, transport ok).
    await host.page.evaluate(() => (window as any).__replay.play());
    await host.page.waitForTimeout(400);
    const st = await replayState(host.page);
    expect(st.playhead).toBeGreaterThan(st.start);

    expect(host.errors).toEqual([]);
  }, 240_000);
});
