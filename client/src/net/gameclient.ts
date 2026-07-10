import {
  ClientSim,
  encode_add_bot,
  encode_input,
  encode_ping,
  encode_remove_bot,
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
import { playMusic, sfx } from "../game/audio";
import { haptic, JUICE } from "../game/juice";
import { ANIM_DANCE } from "../game/players";
import type { Renderer } from "../game/renderer";
import type { InputManager } from "../game/input";
import { colorOf, esc, type PhaseCtx, type UI } from "../ui/ui";

const TICK_MS = 1000 / constants.tickRate;
const INTERP_TICKS = (constants.interpDelayMs / 1000) * constants.tickRate;

interface RemoteSample {
  tick: number;
  pos: Vec3;
  yaw: number;
  anim: number;
  alive: boolean;
  powerup: number;
  intangible: boolean;
  grounded: boolean;
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

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Round-end banners. "{name}" is filled with the winner. One is picked at
// random each round for variety; the "me" set fires when the local player wins.
const ROUND_WIN_LINES = [
  "{name} takes the round!",
  "{name} wins the round!",
  "{name} stands alone!",
  "{name} cleaned house!",
  "{name} rules the arena!",
  "Round goes to {name}!",
  "{name} sweeps the round!",
  "Last bot standing: {name}!",
] as const;

const ROUND_WIN_LINES_ME = [
  "You take the round!",
  "Last bot standing — that's you!",
  "You smashed 'em all!",
  "Domination! The round is yours!",
  "Winner! You cleaned house!",
  "Nobody left but you!",
] as const;

const ROUND_DRAW_LINES = [
  "Nobody survives!",
  "No survivors!",
  "Everybody wiped out!",
  "Mutual destruction!",
  "Total wipeout — it's a wash!",
] as const;

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
  private myIntangible = false;
  private myGrounded = true;
  private reconnecting = false;
  private disconnectedIds = new Set<number>();
  private spectateTarget: number | null = null;
  private spectatePrevButtons = 0;
  private hitstopMs = 0;
  private lastFocus: Vec3 = [0, 1, 0];
  private lastHitBy = new Map<number, { attacker: number; t: number }>();
  // Display-only dopamine state: my consecutive-hit combo + per-player KO streaks.
  private combo = 0;
  private comboExpiresAt = 0;
  private streaks = new Map<number, number>();
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
      onAddBot: () => this.conn.send(encode_add_bot()),
      onRemoveBot: (id: number) => this.conn.send(encode_remove_bot(id)),
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
        const m = { id: msg.id, name: msg.name, slot: msg.slot, bot: msg.bot };
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
        playMusic("menu");
        break;
      case "Countdown":
        // Server has reset the arena and respawned everyone.
        this.sim?.arena_reset();
        this.localAlive = true;
        this.aliveIds = new Set(this.metas.keys());
        this.spectateTarget = null;
        this.resetCombo();
        this.streaks.clear();
        playMusic("battle");
        break;
      case "Playing":
        this.roundStartTick = phase.roundStartTick;
        this.ui.setCenter("FIGHT!");
        setTimeout(() => {
          if (this.phase.type === "Playing") this.ui.setCenter("");
        }, 900);
        break;
      case "RoundEnd": {
        // Only roll a fresh banner on the real transition, so a duplicate
        // RoundEnd message doesn't swap the text (and re-pop) mid-round.
        if (prev.type !== "RoundEnd") {
          this.ui.setCenter(this.roundEndBanner(phase.winner));
        }
        break;
      }
      case "MatchEnd":
        this.ui.setCenter("");
        sfx.win();
        if (phase.winner === this.myId) haptic(JUICE.haptics.win);
        playMusic("menu");
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
        intangible: ps.intangible,
        grounded: ps.grounded,
      });
      if (buf.length > 40) buf.shift();
      if (ps.disconnected) nextDisc.add(ps.id);
      // Live damage % over each head (data already on the wire).
      this.renderer.setPlayerDamage(ps.id, ps.damage);
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
      this.myIntangible =
        (s.local.state.invuln ?? 0) > 0 || (s.local.state.dash_ticks ?? 0) > 0;
      this.myGrounded = s.local.state.grounded ?? true;
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
        if (p) {
          this.renderer.effects.impactBurst(p, ev.dir, ev.heavy, ev.damage);
          this.renderer.effects.spawnFlash(
            new THREE.Vector3(p.x, p.y + 0.6, p.z),
            ev.heavy ? 1.5 : 0.9 + ev.damage * 0.01,
          );
          this.renderer.spawnDamage([p.x, p.y, p.z], ev.damage, ev.heavy);
        }
        // Combo (display-only): consecutive hits I land inside the window.
        // Getting hit breaks it. Rising pitch per hit in the chain.
        const now = performance.now();
        let pitch = 1;
        if (ev.attacker === this.myId && ev.target !== this.myId) {
          this.combo = now < this.comboExpiresAt ? this.combo + 1 : 1;
          this.comboExpiresAt = now + JUICE.combo.windowMs;
          this.ui.setCombo(this.combo);
          pitch =
            1 +
            Math.min(this.combo - 1, JUICE.combo.pitchMaxSteps) * JUICE.combo.pitchStep;
        } else if (ev.target === this.myId) {
          this.resetCombo();
        }
        if (ev.heavy) sfx.hitHeavy(pitch);
        else sfx.hitLight(pitch);
        // Feedback scales with the hit, gated on local involvement.
        if (ev.target === this.myId) {
          this.renderer.shake(
            Math.min(
              JUICE.shake.takenMax,
              (ev.heavy ? JUICE.shake.takenHeavy : JUICE.shake.takenLight) +
                ev.damage * JUICE.shake.takenPerDamage,
            ),
          );
          if (ev.heavy) this.renderer.kickFov(JUICE.fov.takenHeavy);
          haptic(ev.heavy ? JUICE.haptics.hitHeavy : JUICE.haptics.hitLight);
        } else if (ev.attacker === this.myId) {
          this.renderer.shake(JUICE.shake.dealtBase + ev.damage * JUICE.shake.dealtPerDamage);
          if (ev.heavy) this.renderer.kickFov(JUICE.fov.dealtHeavy);
          haptic(JUICE.haptics.dealt);
        }
        // Kill-feed credit (valid 5 s) + local hitstop (extend-only).
        this.lastHitBy.set(ev.target, { attacker: ev.attacker, t: now });
        if (ev.target === this.myId || ev.attacker === this.myId) {
          const stop = ev.heavy
            ? Math.min(
                JUICE.hitstop.maxMs,
                JUICE.hitstop.heavyBaseMs + ev.damage * JUICE.hitstop.heavyPerDamage,
              )
            : JUICE.hitstop.lightMs;
          this.hitstopMs = Math.max(this.hitstopMs, stop);
        }
        break;
      }
      case "Slam": {
        const p = this.renderer.playerPos(ev.player);
        if (p) this.renderer.effects.slamRing(p);
        sfx.slam();
        this.renderer.shake(JUICE.shake.slam);
        break;
      }
      case "Death": {
        const p = this.renderer.playerPos(ev.player);
        if (p && p.y > -30) {
          this.renderer.effects.deathBurst(p, this.renderer.playerColor(ev.player), ev.vel);
        }
        // "KO!" where they went out (wire pos; clamped up so it stays in view).
        this.renderer.spawnText(
          [ev.pos[0], Math.max(ev.pos[1], -6), ev.pos[2]],
          "KO!",
          JUICE.floater.koScale,
          JUICE.floater.koColor,
        );
        sfx.death();
        // Kill feed: credit the last attacker within 5 s, else a solo fall.
        const victim = esc(this.metas.get(ev.player)?.name ?? "?");
        const credit = this.lastHitBy.get(ev.player);
        const killer =
          credit && performance.now() - credit.t < 5000 && credit.attacker !== ev.player
            ? credit.attacker
            : null;
        if (killer !== null) {
          const meta = this.metas.get(killer);
          const streak = (this.streaks.get(killer) ?? 0) + 1;
          this.streaks.set(killer, streak);
          const name = `<b style="color:${colorOf(meta?.slot ?? 0)}">${esc(meta?.name ?? "?")}</b>`;
          const spice =
            streak === 2
              ? ` <span class="feed-streak">double KO!</span>`
              : streak >= 3
                ? ` <span class="feed-streak">${streak} KO streak!</span>`
                : "";
          this.ui.addFeed(`${name} knocked out ${victim}${spice}`);
        } else {
          this.ui.addFeed(`${victim} fell`);
        }
        this.streaks.delete(ev.player); // dying ends the victim's streak
        this.lastHitBy.delete(ev.player);
        // KO spectacle: flash for everyone, freeze/kick only when I'm involved.
        const involved = ev.player === this.myId || killer === this.myId;
        this.ui.flash(involved ? 0.5 : 0.3);
        if (involved) {
          this.hitstopMs = Math.max(this.hitstopMs, JUICE.hitstop.koMs);
          this.renderer.kickFov(JUICE.fov.ko);
          this.renderer.shake(JUICE.shake.ko);
        }
        if (ev.player === this.myId) {
          this.resetCombo();
          haptic(JUICE.haptics.death);
        } else if (killer === this.myId) {
          haptic(JUICE.haptics.kill);
        }
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
          this.renderer.effects.spawnFlash(v, 2.2, 0xffb347);
          this.renderer.shake(JUICE.shake.explosion);
          this.renderer.kickFov(JUICE.fov.explosion);
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

  private resetCombo() {
    this.combo = 0;
    this.comboExpiresAt = 0;
    this.ui.setCombo(0);
  }

  /** Pick a random round-end banner for the given winner (null = draw). */
  private roundEndBanner(winner: number | null): string {
    if (winner === null) return pick(ROUND_DRAW_LINES);
    if (winner === this.myId) return pick(ROUND_WIN_LINES_ME);
    const name = this.metas.get(winner)?.name ?? "???";
    return pick(ROUND_WIN_LINES).replace("{name}", name);
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
    if (pressed & BTN_DASH) {
      sfx.dash();
      this.renderer.kickFov(JUICE.fov.dash); // anticipation zoom-in
    }
    if (pressed & BTN_LIGHT) {
      if (this.myPowerup === PU_GUN) sfx.shoot();
      else if (this.myPowerup === PU_BOMB) sfx.throwBomb();
      else if (!this.myGrounded) sfx.swingAir();
      else sfx.swing();
    } else if (pressed & BTN_HEAVY) {
      sfx.swingHeavy();
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
          intangible: b.intangible,
          grounded: b.grounded,
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
    // Hitstop: freeze the world briefly on a solid hit for impact. Time still
    // accrues into the accumulator so the sim catches up after (no input loss).
    if (this.hitstopMs > 0) {
      this.hitstopMs -= dtMs;
      this.accumulator += dtMs;
      this.renderer.render(0, this.lastFocus, this.input.camYaw, this.input.camPitch);
      return;
    }
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
      const s = this.input.sample();
      this.prevButtons = 0;
      // Spectator: while dead mid-round, follow a survivor; attack/dash cycles.
      if (this.phase.type === "Playing" && !this.localAlive) {
        const pressed = s.buttons & ~this.spectatePrevButtons;
        this.spectatePrevButtons = s.buttons;
        const survivors = [...this.aliveIds]
          .filter((id) => id !== this.myId)
          .sort((a, b) => a - b);
        if (survivors.length > 0) {
          let t = this.spectateTarget;
          if (t === null || !survivors.includes(t)) t = survivors[0];
          else if (pressed & (BTN_LIGHT | BTN_DASH)) {
            t = survivors[(survivors.indexOf(t) + 1) % survivors.length];
          }
          if (t !== this.spectateTarget) {
            this.spectateTarget = t;
            const nm = this.metas.get(t)?.name ?? "?";
            this.ui.setCenter("KO!", `spectating ${nm} — attack to cycle`);
          }
        } else {
          this.spectateTarget = null;
        }
      } else {
        this.spectatePrevButtons = 0;
        this.spectateTarget = null;
      }
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
          this.myIntangible,
          this.myGrounded,
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
        this.renderer.setPlayerState(
          id,
          smp.pos,
          smp.yaw,
          anim,
          dtSec,
          smp.powerup,
          smp.intangible,
          smp.grounded,
        );
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

    // Spectator camera: follow the chosen survivor instead of arena center.
    if (this.phase.type === "Playing" && !this.localAlive && this.spectateTarget !== null) {
      const buf = this.buffers.get(this.spectateTarget);
      const smp = buf ? this.sampleBuffer(buf, renderTick) : null;
      if (smp) focus = smp.pos;
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
    if (this.combo > 0 && now >= this.comboExpiresAt) this.resetCombo();
    this.ui.setDamage(this.myDamage, this.localAlive);
    this.ui.setPowerup(
      this.localAlive ? POWERUP_NAMES[this.myPowerup] ?? "" : "",
      this.myPowerupTicks / constants.tickRate,
      "#" + (POWERUP_COLORS[this.myPowerup] ?? 0xffffff).toString(16).padStart(6, "0"),
    );
    this.lastFocus = focus;
    this.renderer.render(dtSec, focus, this.input.camYaw, this.input.camPitch);
  }
}
