// TypeScript mirrors of the JS-facing types emitted by sim-wasm's
// decode_server_msg (see crates/sim-wasm/src/lib.rs).

export type Vec3 = [number, number, number];

export interface PlayerMeta {
  id: number;
  name: string;
  slot: number;
  bot: boolean;
  /** Bot difficulty index into BOT_DIFF_NAMES; 0 for humans. */
  difficulty: number;
}

export interface PlayerState {
  id: number;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  anim: number;
  grounded: boolean;
  launched: boolean;
  alive: boolean;
  disconnected: boolean;
  intangible: boolean;
  damage: number;
  powerup: number;
}

export interface Pickup {
  id: number;
  kind: number;
  pos: Vec3;
}

export interface Projectile {
  id: number;
  kind: number;
  pos: Vec3;
  vel: Vec3;
}

export interface Score {
  id: number;
  wins: number;
}

export type Phase =
  | { type: "Lobby"; host: number }
  | { type: "Countdown"; round: number; startTick: number }
  | { type: "Playing"; round: number; roundStartTick: number }
  | { type: "RoundEnd"; winner: number | null; scores: Score[] }
  | { type: "MatchEnd"; winner: number; scores: Score[] };

export type GameEvent =
  | {
      type: "Hit";
      attacker: number;
      target: number;
      dir: Vec3;
      heavy: boolean;
      damage: number;
    }
  | { type: "Slam"; player: number; pos: Vec3 }
  | { type: "Death"; player: number; pos: Vec3; vel: Vec3 }
  | { type: "TileWarn"; tile: number }
  | { type: "TileFall"; tile: number }
  | { type: "PickupSpawn"; id: number; kind: number; pos: Vec3 }
  | { type: "PickupTaken"; id: number; player: number; kind: number }
  | { type: "Fired"; player: number; kind: number }
  | { type: "Explosion"; pos: Vec3; kind: number };

/** Opaque-ish reconciliation snapshot; passed back into the WASM sim as-is. */
export interface CharSnapshot {
  pos: Vec3;
  vel: Vec3;
  state: {
    facing: number;
    launched: number;
    grounded: boolean;
    powerup: number;
    powerup_ticks: number;
    invuln: number;
    dash_ticks: number;
    [k: string]: unknown;
  };
  damage: number;
  alive: boolean;
}

export interface Snapshot {
  tick: number;
  lastInputSeq: number;
  inputBufferLen: number;
  players: PlayerState[];
  pickups: Pickup[];
  projectiles: Projectile[];
  local: CharSnapshot | null;
  events: GameEvent[];
}

export type ServerMsg =
  | {
      type: "Welcome";
      yourId: number;
      code: string;
      players: PlayerMeta[];
      phase: Phase;
      tick: number;
      token: string;
    }
  | {
      type: "PlayerJoined";
      id: number;
      name: string;
      slot: number;
      bot: boolean;
      difficulty: number;
    }
  | { type: "PlayerLeft"; id: number }
  | { type: "PhaseChange"; phase: Phase; tick: number }
  | { type: "Snapshot"; snapshot: Snapshot }
  | { type: "Pong"; t: number }
  | { type: "Error"; msg: string };

// Must match gameserver bot::BotDifficulty.
export const BOT_DIFF_NAMES = ["EASY", "MEDIUM", "HARD", "EXPERT", "IMPOSSIBLE"] as const;

// Must match sim::types::buttons.
export const BTN_JUMP = 1 << 0;
export const BTN_DASH = 1 << 1;
export const BTN_LIGHT = 1 << 2;
export const BTN_HEAVY = 1 << 3;

// Must match sim::types::powerup.
export const PU_NONE = 0;
export const PU_HAMMER = 1;
export const PU_ANCHOR = 2;
export const PU_GUN = 3;
export const PU_BOMB = 4;

export const POWERUP_NAMES = ["", "HAMMER", "ANCHOR", "GUN", "BOMB"] as const;
export const POWERUP_COLORS = [0xffffff, 0xff9c4d, 0x4dd2ff, 0xffe94d, 0xff5555] as const;

export const ANIM = {
  Idle: 0,
  Run: 1,
  Air: 2,
  Dash: 3,
  WindupLight: 4,
  SwingLight: 5,
  WindupHeavy: 6,
  SwingHeavy: 7,
  Slam: 8,
  Launched: 9,
  Dead: 10,
} as const;
