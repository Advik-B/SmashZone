import {
  ClientSim,
  encode_input,
  encode_ping,
  encode_rematch,
  encode_start_match,
} from "../wasm/pkg/sim_wasm";
import constants from "../../../shared/constants.json";
import { Connection } from "./connection";
import type {
  CharSnapshot,
  GameEvent,
  Phase,
  PlayerMeta,
  ServerMsg,
  Snapshot,
  Vec3,
} from "./messages";
import {
  ANIM,
  BTN_DASH,
  BTN_JUMP,
  BTN_LIGHT,
  BTN_HEAVY,
  POWERUP_COLORS,
  POWERUP_NAMES,
  PU_BOMB,
  PU_GUN,
} from "./messages";
import * as THREE from "three";
import { sfx } from "../game/audio";
import { ANIM_DANCE } from "../game/players";
import type { Renderer } from "../game/renderer";
import type { InputManager } from "../game/input";
import type { PhaseCtx, UI } from "../ui/ui";

const TICK_MS = 1000 / constants.tickRate;
const INTERP_TICKS = (constants.interpDelayMs / 1000) * constants.tickRate;

interface RemoteSample {
  tick: number;
  pos: Vec3;
  yaw: number;
  anim: number;
  alive: boolean;
  powerup: number;
}

interface ProjSample {
  tick: number;
  pos: Vec3;
}

interface PendingInput {
  seq: number;
  moveX: number;
  moveZ: number;
  yaw: number;
  buttons: number;
  pos: Vec3;
  vel: Vec3;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class GameClient {
  private conn: Connection;
  private sim: ClientSim | null = null;
  private myId = -1;
  private code = "";
  private hostId = 0;
  private metas = new Map<number, PlayerMeta>();
  private buffers = new Map<number, RemoteSample[]>();
  private phase: Phase = { type: "Lobby", host: 0 };
  private pending: PendingInput[] = [];
  private seq = 0;
  private accumulator = 0;
  private rateAdj = 1.0;
  private lastSnapTick = 0;
  private lastSnapTimeMs = 0;
  private roundStartTick = 0;
  private prevKin = new Float32Array(7);
  private curKin = new Float32Array(7);
  private localAlive = true;
  private myDamage = 0;
  private rtt = 0;
  private lastUpdateMs = 0;
  private pingTimer: number;
  private aliveIds = new Set<number>();
  private lastScores = new Map<number, number>();
  private lastCountdown = -1;
  private projBuffers = new Map<number, { kind: number; samples: ProjSample[] }>();
  private myPowerup = 0;
  private myPowerupTicks = 0;
  private reconnecting = false;
  private disconnectedIds = new Set<number>();
  destroyed = false;

  constructor(
    code: string,
    name: string,
    private renderer: Renderer,
    private input: InputManager,
    private ui: UI,
    private onExit: (reason: string) => void,
  ) {
    this.conn = new Connection(code, name);
    this.conn.onMessage = (m) => this.onMessage(m);
    this.conn.onReconnecting = (attempt) => {
      this.reconnecting = true;
      this.ui.setCenter("reconnecting…", `attempt ${attempt}`);
    };
    this.conn.onClose = (reason) => {
      this.destroyed = true;
      clearInterval(this.pingTimer);
      this.onExit(reason);
    };
    this.pingTimer = window.setInterval(() => {
      this.conn.send(encode_ping(performance.now() & 0x7fffffff));
    }, 2000);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.pingTimer);
    this.conn.close();
  }

  /** Dispose all per-session state so a reconnect Welcome rebuilds cleanly.
   *  (lastScores is intentionally kept so the scoreboard survives a blip.) */
  private resetWorld() {
    this.sim?.free();
    this.sim = null;
    this.metas.clear();
    this.buffers.clear();
    this.projBuffers.clear();
    this.pending = [];
    this.aliveIds.clear();
    this.disconnectedIds.clear();
    this.renderer.reset();
  }

  private predicting(): boolean {
    return (
      this.sim !== null &&
      !this.reconnecting &&
      this.localAlive &&
      (this.phase.type === "Lobby" || this.phase.type === "Playing")
    );
  }

  private phaseCtx(): PhaseCtx {
    return {
      myId: this.myId,
      host: this.hostId,
      metas: this.metas,
      code: this.code,
      onStart: () => this.conn.send(encode_start_match()),
      onRematch: () => this.conn.send(encode_rematch()),
    };
  }

  private onMessage(msg: ServerMsg) {
    switch (msg.type) {
      case "Welcome": {
        // Tear down any prior session so this handler works for both the
        // first join and a reconnect re-Welcome (rebuilt from the roster
        // the server sends here).
        this.resetWorld();
        this.reconnecting = false;
        this.myId = msg.yourId;
        this.code = msg.code;
        this.conn.setToken(msg.token);
        this.input.reset();
        this.sim = new ClientSim(this.myId);
        this.sim.add_local(0, 1.05, 0);
        for (const m of msg.players) {
          this.metas.set(m.id, m);
          this.buffers.set(m.id, []);
          this.renderer.addPlayer(m.id, m.name, m.slot);
          if (m.id !== this.myId) this.sim.add_proxy(m.id, 0, -50, 0);
        }
        this.renderer.setTiles(this.sim.tile_centers());
        this.ui.buildHud(this.code);
        this.applyPhase(msg.phase);
        break;
      }
      case "PlayerJoined": {
        const m = { id: msg.id, name: msg.name, slot: msg.slot };
        this.metas.set(m.id, m);
        this.buffers.set(m.id, []);
        this.renderer.addPlayer(m.id, m.name, m.slot);
        if (this.sim && m.id !== this.myId) this.sim.add_proxy(m.id, 0, -50, 0);
        this.refreshOverlay();
        break;
      }
      case "PlayerLeft": {
        this.metas.delete(msg.id);
        this.buffers.delete(msg.id);
        this.renderer.removePlayer(msg.id);
        this.sim?.remove_player(msg.id);
        this.aliveIds.delete(msg.id);
        this.refreshOverlay();
        break;
      }
      case "PhaseChange":
        this.applyPhase(msg.phase);
        break;
      case "Snapshot":
        this.onSnapshot(msg.snapshot);
        break;
      case "Pong":
        this.rtt = (performance.now() & 0x7fffffff) - msg.t;
        this.ui.setPing(this.rtt);
        break;
      case "Error":
        // Connection close handler surfaces it.
        break;
    }
  }

  private refreshOverlay() {
    if (this.phase.type === "Lobby") this.hostId = this.phase.host;
    this.ui.setPhaseOverlay(this.phase, this.phaseCtx());
    if (this.phase.type === "RoundEnd" || this.phase.type === "MatchEnd") {
      this.lastScores = new Map(this.phase.scores.map((s) => [s.id, s.wins]));
    }
    const scores = [...this.metas.keys()].map((id) => ({
      id,
      wins: this.lastScores.get(id) ?? 0,
    }));
    this.ui.setScores(
      this.metas,
      scores,
      this.phase.type === "Playing" ? this.aliveIds : undefined,
      this.disconnectedIds,
    );
  }

  private applyPhase(phase: Phase) {
    const prev = this.phase;
    this.phase = phase;
    this.pending = [];
    if (phase.type === "Countdown" && prev.type === "MatchEnd") {
      this.lastScores.clear(); // rematch resets the score
    }

    switch (phase.type) {
      case "Lobby":
        this.hostId = phase.host;
        this.localAlive = true;
        this.ui.setCenter("");
        break;
      case "Countdown":
        // Server has reset the arena and respawned everyone.
        this.sim?.arena_reset();
        this.localAlive = true;
        this.aliveIds = new Set(this.metas.keys());
        break;
      case "Playing":
        this.roundStartTick = phase.roundStartTick;
        this.ui.setCenter("FIGHT!");
        setTimeout(() => {
          if (this.phase.type === "Playing") this.ui.setCenter("");
        }, 900);
        break;
      case "RoundEnd": {
        const name =
          phase.winner !== null
            ? this.metas.get(phase.winner)?.name ?? "???"
            : null;
        this.ui.setCenter(
          name ? `${name} takes the round!` : "Nobody survives!",
        );
        break;
      }
      case "MatchEnd":
        this.ui.setCenter("");
        sfx.win();
        break;
    }
    this.refreshOverlay();
  }

  private onSnapshot(s: Snapshot) {
    if (!this.sim) return;
    this.lastSnapTick = s.tick;
    this.lastSnapTimeMs = performance.now();

    // Input-rate feedback: keep the server's buffer at ~1-3 inputs.
    if (s.inputBufferLen < 1) this.rateAdj = 1.03;
    else if (s.inputBufferLen > 3) this.rateAdj = 0.97;
    else this.rateAdj = 1.0;

    // Buffer states for interpolation (all players incl. self; self is used
    // when not predicting, e.g. during countdown or while dead).
    const nextDisc = new Set<number>();
    for (const ps of s.players) {
      let buf = this.buffers.get(ps.id);
      if (!buf) {
        buf = [];
        this.buffers.set(ps.id, buf);
      }
      buf.push({
        tick: s.tick,
        pos: ps.pos,
        yaw: ps.yaw,
        anim: ps.anim,
        alive: ps.alive,
        powerup: ps.powerup,
      });
      if (buf.length > 40) buf.shift();
      if (ps.disconnected) nextDisc.add(ps.id);
      if (this.phase.type === "Playing") {
        if (ps.alive) this.aliveIds.add(ps.id);
        else if (this.aliveIds.delete(ps.id)) this.refreshOverlay();
      }
    }
    // Dimmed-scoreboard state: refresh only when the disconnected set changes.
    if (
      nextDisc.size !== this.disconnectedIds.size ||
      [...nextDisc].some((id) => !this.disconnectedIds.has(id))
    ) {
      this.disconnectedIds = nextDisc;
      this.refreshOverlay();
    }

    // Pickups render straight from the authoritative list.
    this.renderer.setPickups(s.pickups);

    // Projectiles: append interpolation samples, drop vanished ids.
    const liveProj = new Set<number>();
    for (const pr of s.projectiles) {
      liveProj.add(pr.id);
      let entry = this.projBuffers.get(pr.id);
      if (!entry) {
        entry = { kind: pr.kind, samples: [] };
        this.projBuffers.set(pr.id, entry);
      }
      entry.samples.push({ tick: s.tick, pos: pr.pos });
      if (entry.samples.length > 12) entry.samples.shift();
    }
    for (const id of this.projBuffers.keys()) {
      if (!liveProj.has(id)) this.projBuffers.delete(id);
    }

    // Events -> effects. Tile events are ignored here: the local sim's
    // arena_apply_until emits identical ones in sync with collision changes.
    for (const ev of s.events) this.onEvent(ev);

    // Arena catch-up during play.
    if (this.phase.type === "Playing") {
      const roundTick = Math.max(0, s.tick - this.roundStartTick);
      const tileEvents = this.sim.arena_apply_until(roundTick) as GameEvent[];
      for (const ev of tileEvents) {
        if (ev.type === "TileFall") {
          this.renderer.tileFall(ev.tile);
          sfx.tileFall();
        }
      }
    }

    // Reconciliation.
    if (s.local) {
      this.myDamage = s.local.damage;
      this.myPowerup = s.local.state.powerup ?? 0;
      this.myPowerupTicks = s.local.state.powerup_ticks ?? 0;
      // Sync the prediction world's powerup so gun/bomb inputs predict as
      // fire (not melee) immediately after a pickup.
      this.sim.set_local_powerup(this.myPowerup, this.myPowerupTicks);
      const wasAlive = this.localAlive;
      this.localAlive = s.local.alive;
      if (wasAlive && !this.localAlive && this.phase.type === "Playing") {
        this.ui.setCenter("KO!", "spectating…");
      }

      if (this.predicting()) {
        const idx = this.pending.findIndex((p) => p.seq === s.lastInputSeq);
        if (idx === -1) {
          // Nothing to compare against (fresh join, phase change, overflow).
          this.sim.restore_local(s.local as unknown as CharSnapshot);
          this.pending = [];
          const kin = this.sim.local_kin();
          this.prevKin.set(kin);
          this.curKin.set(kin);
        } else {
          const p = this.pending[idx];
          const ep = Math.hypot(
            p.pos[0] - s.local.pos[0],
            p.pos[1] - s.local.pos[1],
            p.pos[2] - s.local.pos[2],
          );
          const ev = Math.hypot(
            p.vel[0] - s.local.vel[0],
            p.vel[1] - s.local.vel[1],
            p.vel[2] - s.local.vel[2],
          );
          if (ep > constants.reconcilePosError || ev > constants.reconcileVelError) {
            this.sim.restore_local(s.local as unknown as CharSnapshot);
            for (let i = idx + 1; i < this.pending.length; i++) {
              const q = this.pending[i];
              this.sim.step_local(q.moveX, q.moveZ, q.yaw, q.buttons);
              const kin = this.sim.local_kin();
              q.pos = [kin[0], kin[1], kin[2]];
              q.vel = [kin[3], kin[4], kin[5]];
            }
            const kin = this.sim.local_kin();
            this.curKin.set(kin);
            if (ep > 1.5) this.prevKin.set(kin); // big correction: snap render
          }
          this.pending.splice(0, idx + 1);
        }
      } else {
        // Not predicting: track authority directly so we resume cleanly.
        this.sim.restore_local(s.local as unknown as CharSnapshot);
        const kin = this.sim.local_kin();
        this.prevKin.set(kin);
        this.curKin.set(kin);
      }
    }
  }

  private onEvent(ev: GameEvent) {
    switch (ev.type) {
      case "Hit": {
        this.renderer.flashPlayer(ev.target);
        const p = this.renderer.playerPos(ev.target);
        if (p) this.renderer.effects.hitBurst(p, ev.heavy);
        if (ev.heavy) sfx.hitHeavy();
        else sfx.hitLight();
        if (ev.target === this.myId) this.renderer.shake(ev.heavy ? 0.45 : 0.25);
        else if (ev.attacker === this.myId) this.renderer.shake(0.12);
        break;
      }
      case "Slam": {
        const p = this.renderer.playerPos(ev.player);
        if (p) this.renderer.effects.slamRing(p);
        sfx.slam();
        this.renderer.shake(0.2);
        break;
      }
      case "Death": {
        const p = this.renderer.playerPos(ev.player);
        if (p && p.y > -30) {
          this.renderer.effects.deathBurst(p, this.renderer.playerColor(ev.player));
        }
        sfx.death();
        if (ev.player === this.myId) this.renderer.shake(0.4);
        break;
      }
      case "PickupSpawn": {
        sfx.pickupSpawn();
        const v = new THREE.Vector3(ev.pos[0], ev.pos[1], ev.pos[2]);
        this.renderer.effects.hitBurst(v, false);
        break;
      }
      case "PickupTaken": {
        sfx.pickup();
        const p = this.renderer.playerPos(ev.player);
        if (p) this.renderer.effects.hitBurst(p, false);
        break;
      }
      case "Fired": {
        // Local player's shot sound already played on the button press.
        if (ev.player !== this.myId) {
          if (ev.kind === PU_GUN) sfx.shoot();
          else sfx.throwBomb();
        }
        break;
      }
      case "Explosion": {
        const v = new THREE.Vector3(ev.pos[0], ev.pos[1], ev.pos[2]);
        if (ev.kind === PU_BOMB) {
          this.renderer.effects.hitBurst(v, true);
          this.renderer.effects.slamRing(v);
          this.renderer.shake(0.3);
          sfx.explosion();
        } else {
          this.renderer.effects.hitBurst(v, false);
        }
        break;
      }
      default:
        break; // tile events handled via local sim
    }
  }

  private estServerTick(now: number): number {
    return (
      this.lastSnapTick +
      ((now - this.lastSnapTimeMs) / 1000) * constants.tickRate
    );
  }

  private prevButtons = 0;

  private simTick() {
    if (!this.sim) return;
    const inp = this.input.sample();
    // Local action sounds on button edges (server confirms hits separately).
    const pressed = inp.buttons & ~this.prevButtons;
    this.prevButtons = inp.buttons;
    if (pressed & BTN_JUMP) sfx.jump();
    if (pressed & BTN_DASH) sfx.dash();
    if (pressed & BTN_LIGHT) {
      if (this.myPowerup === PU_GUN) sfx.shoot();
      else if (this.myPowerup === PU_BOMB) sfx.throwBomb();
      else sfx.swing();
    } else if (pressed & BTN_HEAVY) {
      sfx.swing();
    }
    this.seq = (this.seq + 1) & 0xffff;
    this.conn.send(
      encode_input(this.seq, inp.moveX, inp.moveZ, inp.yaw, inp.buttons),
    );
    this.sim.step_local(inp.moveX, inp.moveZ, inp.yaw, inp.buttons);
    this.prevKin.set(this.curKin);
    const kin = this.sim.local_kin();
    this.curKin.set(kin);
    this.pending.push({
      seq: this.seq,
      moveX: inp.moveX,
      moveZ: inp.moveZ,
      yaw: inp.yaw,
      buttons: inp.buttons,
      pos: [kin[0], kin[1], kin[2]],
      vel: [kin[3], kin[4], kin[5]],
    });
    if (this.pending.length > 180) this.pending.shift();
  }

  private sampleBuffer(buf: RemoteSample[], tick: number): RemoteSample | null {
    if (buf.length === 0) return null;
    if (tick <= buf[0].tick) return buf[0];
    const last = buf[buf.length - 1];
    if (tick >= last.tick) return last;
    for (let i = buf.length - 2; i >= 0; i--) {
      const a = buf[i];
      const b = buf[i + 1];
      if (a.tick <= tick && tick <= b.tick) {
        const t = (tick - a.tick) / Math.max(1, b.tick - a.tick);
        return {
          tick,
          pos: [
            a.pos[0] + (b.pos[0] - a.pos[0]) * t,
            a.pos[1] + (b.pos[1] - a.pos[1]) * t,
            a.pos[2] + (b.pos[2] - a.pos[2]) * t,
          ],
          yaw: lerpAngle(a.yaw, b.yaw, t),
          anim: b.anim,
          alive: b.alive,
          powerup: b.powerup,
        };
      }
    }
    return last;
  }

  /** Called every animation frame. */
  frame(now: number) {
    if (this.destroyed || !this.sim) return;
    const dtMs = Math.min(100, now - (this.lastUpdateMs || now));
    this.lastUpdateMs = now;
    const dtSec = dtMs / 1000;
    this.input.update(dtSec);

    // Fixed-timestep prediction.
    if (this.predicting()) {
      this.accumulator += dtMs;
      const tickLen = TICK_MS / this.rateAdj;
      let steps = 0;
      while (this.accumulator >= tickLen && steps < 6) {
        this.simTick();
        this.accumulator -= tickLen;
        steps++;
      }
      if (steps === 6) this.accumulator = 0; // tab was backgrounded
    } else {
      this.accumulator = 0;
      // Keep draining the sampler while frozen so button presses latched
      // during round-end/countdown don't fire on the first tick of the
      // next round.
      this.input.sample();
      this.prevButtons = 0;
    }

    // Countdown display + beeps.
    const est = this.estServerTick(now);
    if (this.phase.type === "Countdown") {
      const secs = Math.max(0, Math.ceil((this.phase.startTick - est) / constants.tickRate));
      if (secs !== this.lastCountdown) {
        this.lastCountdown = secs;
        if (secs > 0) sfx.count();
        else sfx.go();
      }
      this.ui.setCenter(`${secs || "GO"}`, `round ${this.phase.round}`);
    } else {
      this.lastCountdown = -1;
    }

    // Local player render state.
    const renderTick = est - INTERP_TICKS;
    let focus: Vec3 = [0, 1, 0];
    const alpha = Math.max(0, Math.min(1, this.accumulator / TICK_MS));

    for (const [id] of this.metas) {
      if (id === this.myId && this.predicting()) {
        const px = this.prevKin[0] + (this.curKin[0] - this.prevKin[0]) * alpha;
        const py = this.prevKin[1] + (this.curKin[1] - this.prevKin[1]) * alpha;
        const pz = this.prevKin[2] + (this.curKin[2] - this.prevKin[2]) * alpha;
        this.renderer.setPlayerState(
          id,
          [px, py, pz],
          this.curKin[6],
          this.sim.local_anim(),
          dtSec,
          this.myPowerup,
        );
        focus = [px, py, pz];
      } else {
        const buf = this.buffers.get(id);
        const smp = buf ? this.sampleBuffer(buf, renderTick) : null;
        if (!smp) continue;
        let anim = smp.alive ? smp.anim : ANIM.Dead;
        if (this.phase.type === "MatchEnd" && id === this.phase.winner) {
          anim = ANIM_DANCE; // champion gets a dance
        }
        this.renderer.setPlayerState(id, smp.pos, smp.yaw, anim, dtSec, smp.powerup);
        if (id === this.myId) {
          focus = smp.alive ? smp.pos : [0, 1, 0];
        } else if (this.sim) {
          // Keep the prediction world's proxy in sync for collisions.
          if (smp.alive) {
            this.sim.set_proxy(id, smp.pos[0], smp.pos[1], smp.pos[2], smp.yaw);
          } else {
            this.sim.set_proxy(id, 0, -60, 0, 0);
          }
        }
      }
    }

    // Projectiles: interpolate each id's sample buffer at the render tick.
    const projList: { id: number; kind: number; pos: Vec3 }[] = [];
    for (const [id, entry] of this.projBuffers) {
      const s = entry.samples;
      if (s.length === 0) continue;
      let pos: Vec3;
      if (s.length === 1 || renderTick >= s[s.length - 1].tick) {
        pos = s[s.length - 1].pos;
      } else if (renderTick <= s[0].tick) {
        pos = s[0].pos;
      } else {
        pos = s[s.length - 1].pos;
        for (let i = s.length - 2; i >= 0; i--) {
          if (s[i].tick <= renderTick) {
            const a = s[i];
            const b = s[i + 1];
            const t = (renderTick - a.tick) / Math.max(1, b.tick - a.tick);
            pos = [
              a.pos[0] + (b.pos[0] - a.pos[0]) * t,
              a.pos[1] + (b.pos[1] - a.pos[1]) * t,
              a.pos[2] + (b.pos[2] - a.pos[2]) * t,
            ];
            break;
          }
        }
      }
      projList.push({ id, kind: entry.kind, pos });
    }
    this.renderer.updateProjectiles(projList);

    this.renderer.updateTiles(this.sim.tile_states());
    this.ui.setDamage(this.myDamage, this.localAlive);
    this.ui.setPowerup(
      this.localAlive ? POWERUP_NAMES[this.myPowerup] ?? "" : "",
      this.myPowerupTicks / constants.tickRate,
      "#" + (POWERUP_COLORS[this.myPowerup] ?? 0xffffff).toString(16).padStart(6, "0"),
    );
    this.renderer.render(dtSec, focus, this.input.camYaw, this.input.camPitch);
  }
}
