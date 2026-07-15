// Replay playback driver. Exposes the same frame(now)/destroy() shape as
// GameClient so main.ts's rAF loop hosts either. World state comes straight
// from recorded snapshots (absolute positions, lerped between the bracketing
// 20 Hz samples — the live remote-player pipeline, minus prediction), arena
// tiles from a headless ClientSim (collapse is a pure function of round
// tick, so seeks are reset + re-apply), and hit/KO feedback from the shared
// eventfx dispatcher.

import { ClientSim } from "../wasm/pkg/sim_wasm";
import constants from "../../../shared/constants.json";
import { playMusic, sfx } from "../game/audio";
import { dispatchEventFx } from "../game/eventfx";
import { lerpAngle, lerpVec3 } from "../game/interp";
import { ANIM_DANCE } from "../game/players";
import type { InputManager } from "../game/input";
import type { Renderer } from "../game/renderer";
import { ANIM, type GameEvent, type Phase, type Vec3 } from "../net/messages";
import { ReplayCameraRig, type ReplayCameraMode } from "./cameras";
import { GAP_TICKS, type ReplayDataset } from "./dataset";
import { exportVideo, type ExportHandle, type ExportRequest } from "./export";
import type { ReplayViewerUI } from "./replayui";

const TICK_MS = 1000 / constants.tickRate;
/** Above this playback speed, event SFX are muted (machine-gun protection). */
const SFX_MAX_SPEED = 2;
/** FX burst cap per frame — a long seekless jump shouldn't detonate at once. */
const EVENT_BURST_CAP = 32;

export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

export class ReplayPlayer {
  destroyed = false;

  private playhead: number;
  private playing = true;
  private speed = 1;
  private eventCursor: number;
  private lastUpdateMs = 0;
  private sim: ClientSim;
  private arenaRound = -999;
  private arenaTick = -1;
  private presentIds = new Set<number>();
  private lastRoster: Map<number, unknown> | null = null;
  private lastHitBy = new Map<number, { attacker: number; t: number }>();
  private streaks = new Map<number, number>();
  private followTarget: number;
  private lastFocus: Vec3 = [0, 2, 0];
  private lastFocusYaw = 0;
  private lastCountdown = -1;
  private rig: ReplayCameraRig;
  private exporting = false;
  private exportSfx = false;
  private exportFollowYaw = 0;
  /** Set when the most recent export finished (e2e / UI feedback). */
  lastExport: { size: number; type: string } | null = null;

  constructor(
    readonly dataset: ReplayDataset,
    readonly renderer: Renderer,
    private input: InputManager,
    private ui: ReplayViewerUI,
    private onExit: () => void,
  ) {
    this.sim = new ClientSim(0);
    this.playhead = dataset.startTick;
    this.eventCursor = dataset.eventIndexAfter(dataset.startTick);
    this.followTarget = dataset.header.localPlayerId;
    this.rig = new ReplayCameraRig(renderer.canvas, input, renderer.camera);
    this.rig.attach();
    this.input.reset();
    this.renderer.reset();
    this.renderer.setTiles(this.sim.tile_centers());
    this.syncRoster(true);
    this.applyArena(true);
    this.renderer.clearTransients();
    playMusic("battle");
    this.ui.mount(this);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rig.detach();
    this.ui.unmount();
    this.renderer.setCameraOverride(null);
    this.renderer.clearTransients();
    this.renderer.reset();
    // Leave the arena whole for the menu backdrop behind us.
    this.sim.arena_reset();
    this.renderer.updateTiles(this.sim.tile_states());
    this.sim.free();
    playMusic("menu");
  }

  /** Back button / Esc: tear down and hand control back to the menu. */
  exit() {
    if (this.destroyed) return;
    this.destroy();
    this.onExit();
  }

  // ---- transport ----

  get playheadTick(): number {
    return this.playhead;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  get followTargetId(): number {
    return this.followTarget;
  }

  get cameraMode(): ReplayCameraMode {
    return this.rig.mode;
  }

  setCameraMode(mode: ReplayCameraMode) {
    this.rig.setMode(mode);
    this.renderer.snapCamera();
    if (mode !== "free") this.renderer.setCameraOverride(null);
  }

  play() {
    if (this.playhead >= this.dataset.endTick) this.seek(this.dataset.startTick);
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(mult: number) {
    this.speed = Math.max(0.25, Math.min(4, mult));
  }

  setFollowTarget(id: number) {
    this.followTarget = id;
    this.rig.resetPlayerView();
    this.renderer.snapCamera();
  }

  /** Absolute seek. State rebuilds silently; crossed events never re-fire. */
  seek(tick: number) {
    const target = Math.max(this.dataset.startTick, Math.min(this.dataset.endTick, tick));
    this.playhead = target;
    this.eventCursor = this.dataset.eventIndexAfter(target);
    this.lastHitBy.clear();
    this.streaks.clear();
    this.renderer.clearTransients();
    this.rig.resetPlayerView();
    this.ui.clearFeed();
    this.syncRoster(true);
    this.applyArena(true);
    // The rAF loop renders paused frames too, so scrubbing is live.
  }

  seekFrac(frac: number) {
    const f = Math.max(0, Math.min(1, frac));
    this.seek(this.dataset.startTick + (this.dataset.endTick - this.dataset.startTick) * f);
  }

  /** Pause and hop ±n snapshots (one snapshot = 3 sim ticks). */
  stepSnapshots(n: number) {
    this.pause();
    const i = this.dataset.indexForTick(this.playhead);
    const j =
      n > 0 || this.playhead > this.dataset.snapshotTick(i) + 0.001
        ? i + Math.max(n, n > 0 ? n : 0)
        : i + n;
    this.seek(this.dataset.snapshotTick(j));
  }

  /** Jump to the previous/next KO marker. */
  jumpToMarker(dir: 1 | -1) {
    const kos = this.dataset.markers.filter((m) => m.kind === "ko");
    if (kos.length === 0) return;
    const eps = 2;
    const target =
      dir > 0
        ? kos.find((m) => m.tick > this.playhead + eps)
        : [...kos].reverse().find((m) => m.tick < this.playhead - eps);
    if (target) this.seek(target.tick);
  }

  // ---- video export facade (driven by replay/export.ts) ----

  get isExporting(): boolean {
    return this.exporting;
  }

  beginExport(startTick: number, targetId: number, withSfx: boolean) {
    this.pause();
    this.setFollowTarget(targetId);
    this.seek(startTick);
    this.exporting = true;
    this.exportSfx = withSfx;
    this.drawWorld(0); // settle focus/facing at the start tick
    this.exportFollowYaw = this.lastFocusYaw + Math.PI;
  }

  /** Render one deterministic export frame at an absolute tick. */
  exportStep(tick: number, dtSec: number, camera: "follow" | "playerview") {
    const prev = this.playhead;
    this.playhead = Math.max(this.dataset.startTick, Math.min(this.dataset.endTick, tick));
    this.fireEvents(prev, this.playhead);
    this.drawWorld(dtSec);
    if (camera === "playerview") {
      const pv = this.rig.playerViewAngles(
        this.dataset,
        this.playhead,
        this.followTarget,
        this.lastFocusYaw,
        dtSec,
      );
      this.renderer.render(dtSec, this.lastFocus, pv.yaw, pv.pitch);
    } else {
      // Deterministic chase cam: ease in behind the target's facing.
      this.exportFollowYaw = lerpAngle(
        this.exportFollowYaw,
        this.lastFocusYaw + Math.PI,
        1 - Math.exp(-2.5 * dtSec),
      );
      this.renderer.render(dtSec, this.lastFocus, this.exportFollowYaw, -0.35);
    }
  }

  endExport() {
    this.exporting = false;
  }

  /**
   * Kick off a video export. Synchronous on purpose: the caller (and the e2e
   * hook) reads playheadTick immediately before this, and exportVideo captures
   * that same tick to restore afterward — an awaited import here would let the
   * still-playing replay advance in between, breaking the restore.
   */
  startExport(opts: ExportRequest): ExportHandle {
    const handle = exportVideo(this, opts);
    void handle.done
      .then((blob) => {
        this.lastExport = { size: blob.size, type: blob.type };
      })
      .catch(() => {});
    return handle;
  }

  // ---- frame loop ----

  frame(now: number) {
    if (this.destroyed) return;
    if (this.exporting) {
      // The export loop owns stepping + rendering; keep the wall clock warm
      // so playback resumes without a jump.
      this.lastUpdateMs = now;
      return;
    }
    const dtMs = Math.min(100, now - (this.lastUpdateMs || now));
    this.lastUpdateMs = now;
    const dtSec = dtMs / 1000;
    this.input.update(dtSec);

    const prev = this.playhead;
    if (this.playing) {
      this.playhead = Math.min(
        this.dataset.endTick,
        this.playhead + (dtMs / TICK_MS) * this.speed,
      );
      if (this.playhead >= this.dataset.endTick) this.playing = false;
    }
    this.fireEvents(prev, this.playhead);
    this.drawWorld(dtSec);

    switch (this.rig.mode) {
      case "free": {
        this.renderer.setCameraOverride(this.rig.updateFree(dtSec));
        this.renderer.render(dtSec, this.lastFocus, 0, 0);
        break;
      }
      case "playerview": {
        const pv = this.rig.playerViewAngles(
          this.dataset,
          this.playhead,
          this.followTarget,
          this.lastFocusYaw,
          dtSec,
        );
        this.renderer.render(dtSec, this.lastFocus, pv.yaw, pv.pitch);
        break;
      }
      default:
        this.renderer.render(dtSec, this.lastFocus, this.input.camYaw, this.input.camPitch);
    }
    this.ui.tick();
  }

  /** Everything between transport and camera: entities, tiles, chrome. */
  private drawWorld(dtSec: number) {
    this.syncRoster(false);
    this.applyArena(false);

    // World sample: lerp between the snapshots bracketing the playhead.
    const ds = this.dataset;
    const i = ds.indexForTick(this.playhead);
    const a = ds.snapshotAt(i);
    const b = ds.snapshotAt(Math.min(i + 1, ds.snapshotCount - 1));
    const span = b.tick - a.tick;
    const gap = span > GAP_TICKS; // reconnect hole: snap, don't glide
    const t = span > 0 ? Math.max(0, Math.min(1, (this.playhead - a.tick) / span)) : 0;
    const phase = ds.phaseAt(this.playhead);

    const aById = new Map(a.players.map((p) => [p.id, p]));
    for (const pb of b.players) {
      if (!this.presentIds.has(pb.id)) continue; // roster says not here yet
      const pa = aById.get(pb.id);
      let pos: Vec3;
      let yaw: number;
      if (!pa || gap) {
        const src = !pa || t >= 0.5 ? pb : pa;
        pos = src.pos;
        yaw = src.yaw;
      } else {
        pos = lerpVec3(pa.pos, pb.pos, t);
        yaw = lerpAngle(pa.yaw, pb.yaw, t);
      }
      let anim = pb.alive ? pb.anim : ANIM.Dead;
      if (phase.type === "MatchEnd" && pb.id === phase.winner) anim = ANIM_DANCE;
      this.renderer.setPlayerState(
        pb.id,
        pos,
        yaw,
        anim,
        dtSec,
        pb.powerup,
        pb.intangible,
        pb.grounded,
      );
      this.renderer.setPlayerDamage(pb.id, pb.damage);
      if (pb.id === this.followTarget && pb.alive) {
        this.lastFocus = pos;
        this.lastFocusYaw = yaw;
      }
    }

    this.renderer.setPickups(a.pickups);

    const bProj = new Map(b.projectiles.map((p) => [p.id, p]));
    this.renderer.updateProjectiles(
      a.projectiles.map((pa2) => {
        const pb2 = bProj.get(pa2.id);
        return {
          id: pa2.id,
          kind: pa2.kind,
          pos: pb2 && !gap ? lerpVec3(pa2.pos, pb2.pos, t) : pa2.pos,
        };
      }),
    );

    this.renderer.updateTiles(this.sim.tile_states());
    this.updateChrome(phase);
  }

  // ---- internals ----

  private get sfxOn(): boolean {
    if (this.exporting) return this.exportSfx;
    return this.speed <= SFX_MAX_SPEED;
  }

  private fireEvents(prevTick: number, newTick: number) {
    if (newTick <= prevTick) return;
    const evs = this.dataset.events;
    let fired = 0;
    while (this.eventCursor < evs.length && evs[this.eventCursor].tick <= newTick) {
      const { ev } = evs[this.eventCursor++];
      if (fired++ >= EVENT_BURST_CAP) continue; // drain cursor, skip the FX
      this.dispatchEvent(ev);
    }
  }

  private dispatchEvent(ev: GameEvent) {
    dispatchEventFx(ev, {
      renderer: this.renderer,
      metas: this.dataset.rosterAt(this.playhead),
      localId: this.followTarget,
      firedSuppressId: null, // in a replay, everyone's shots are audible
      lastHitBy: this.lastHitBy,
      streaks: this.streaks,
      now: () => this.playhead * TICK_MS, // credit window in replay time
      sfxOn: this.sfxOn,
      addFeed: (html) => this.ui.addFeed(html),
      flash: (s) => this.ui.flash(s),
      // No comboPitch/onHitstop/haptic: personal juice stays in live play.
    });
  }

  private syncRoster(force: boolean) {
    const roster = this.dataset.rosterAt(this.playhead);
    if (!force && roster === this.lastRoster) return; // shared-map identity
    this.lastRoster = roster;
    for (const [id, m] of roster) {
      if (!this.presentIds.has(id)) {
        this.renderer.addPlayer(id, m.name, m.slot);
        this.presentIds.add(id);
      }
    }
    for (const id of [...this.presentIds]) {
      if (!roster.has(id)) {
        this.renderer.removePlayer(id);
        this.presentIds.delete(id);
      }
    }
  }

  /**
   * Bring arena tiles to the playhead. Forward motion inside one round
   * applies incrementally (dispatching TileFall debris like live play);
   * segment changes and backward seeks reset + re-apply silently — collapse
   * is a pure function of round tick, so this is microseconds.
   */
  private applyArena(force: boolean) {
    const seg = this.dataset.roundAt(this.playhead);
    const roundKey = seg?.round ?? -1;
    let roundTick = 0;
    if (seg && seg.roundStartTick !== null) {
      const end = seg.endTick ?? this.playhead;
      roundTick = Math.floor(
        Math.max(0, Math.min(this.playhead, end) - seg.roundStartTick),
      );
    }
    if (force || roundKey !== this.arenaRound || roundTick < this.arenaTick) {
      this.sim.arena_reset();
      this.sim.arena_apply_until(roundTick); // seek: no debris, no sound
      this.arenaRound = roundKey;
      this.arenaTick = roundTick;
      return;
    }
    if (roundTick > this.arenaTick) {
      const evs = this.sim.arena_apply_until(roundTick) as GameEvent[];
      this.arenaTick = roundTick;
      for (const ev of evs) {
        if (ev.type === "TileFall") {
          this.renderer.tileFall(ev.tile);
          if (this.sfxOn) sfx.tileFall();
        }
      }
    }
  }

  /** Center-text chrome, computed from phase + playhead (scrub-safe). */
  private updateChrome(phase: Phase) {
    const names = this.dataset.rosterAt(this.playhead);
    switch (phase.type) {
      case "Countdown": {
        const secs = Math.max(
          0,
          Math.ceil((phase.startTick - this.playhead) / constants.tickRate),
        );
        if (secs !== this.lastCountdown) {
          this.lastCountdown = secs;
          if (this.playing && this.sfxOn) {
            if (secs > 0) sfx.count();
            else sfx.go();
          }
        }
        this.ui.setCenter(`${secs || "GO"}`, `round ${phase.round}`);
        return;
      }
      case "Playing": {
        this.lastCountdown = -1;
        const sinceStart = this.playhead - phase.roundStartTick;
        this.ui.setCenter(sinceStart < 54 ? "FIGHT!" : "");
        return;
      }
      case "RoundEnd": {
        this.lastCountdown = -1;
        if (phase.winner === null) {
          this.ui.setCenter("Nobody survives!");
        } else {
          const nm = names.get(phase.winner)?.name ?? "???";
          this.ui.setCenter(`${nm} takes the round!`);
        }
        return;
      }
      case "MatchEnd": {
        this.lastCountdown = -1;
        const nm = names.get(phase.winner)?.name ?? "???";
        this.ui.setCenter(`${nm} WINS!`, "match over");
        return;
      }
      default:
        this.lastCountdown = -1;
        this.ui.setCenter("");
    }
  }
}
