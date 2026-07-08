//! Server-side practice bots. A bot is a room-level pseudo-player: each tick
//! its `BotBrain` produces a `PlayerInput` fed into the sim exactly like a
//! human's, so all round/scoring logic treats it uniformly. The brain's RNG
//! lives here (not in the sim), so sim determinism is untouched.

use sim::arena::TileState;
use sim::constants::consts;
use sim::types::{buttons, PlayerId, PlayerInput};
use sim::GameSim;

pub struct BotBrain {
    rng: u64,
    /// Buttons emitted last tick — we release for one tick so the sim sees a
    /// fresh rising edge (`pressed = buttons & !prev`) on the next press.
    prev_emitted: u8,
}

impl BotBrain {
    pub fn new(id: PlayerId) -> BotBrain {
        BotBrain {
            rng: 0x9E37_79B9_7F4A_7C15 ^ (id as u64 + 1).wrapping_mul(0xD1B5_4A32_D192_ED03),
            prev_emitted: 0,
        }
    }

    fn next(&mut self) -> u32 {
        // xorshift64*
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        (x >> 32) as u32
    }

    fn chance(&mut self, p: f32) -> bool {
        (self.next() as f32 / u32::MAX as f32) < p
    }
}

fn dist2(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dz = a[2] - b[2];
    dx * dx + dz * dz
}

/// If the tile under `pos` is not solid, return the nearest solid tile center
/// (retreat goal); otherwise `None` (standing on safe ground).
fn safe_tile_center(sim: &GameSim, pos: [f32; 3]) -> Option<[f32; 3]> {
    let size = consts().arena_tile_size;
    let gx = (pos[0] / size).round() as i32;
    let gz = (pos[2] / size).round() as i32;
    let on_solid = sim
        .arena
        .tiles
        .iter()
        .any(|t| t.gx == gx && t.gz == gz && t.state == TileState::Solid);
    if on_solid {
        return None;
    }
    let mut best = f32::MAX;
    let mut center = None;
    for t in sim.arena.tiles.iter() {
        if t.state != TileState::Solid {
            continue;
        }
        let ctr = t.center();
        let d = dist2(pos, ctr);
        if d < best {
            best = d;
            center = Some(ctr);
        }
    }
    center
}

/// Compute this tick's input for the bot with id `id`.
pub fn think(sim: &GameSim, id: PlayerId, brain: &mut BotBrain) -> PlayerInput {
    let Some(me) = sim.snapshot(id) else {
        return PlayerInput::default();
    };
    if !me.alive {
        brain.prev_emitted = 0;
        return PlayerInput::default();
    }
    let mp = me.pos;

    // Nearest alive opponent.
    let mut target: Option<[f32; 3]> = None;
    let mut best = f32::MAX;
    for (&oid, _) in sim.players.iter() {
        if oid == id {
            continue;
        }
        let Some(o) = sim.snapshot(oid) else { continue };
        if !o.alive {
            continue;
        }
        let d = dist2(mp, o.pos);
        if d < best {
            best = d;
            target = Some(o.pos);
        }
    }

    // Survival overrides chasing: if we're not on solid ground, head for it.
    let (goal, chasing) = match safe_tile_center(sim, mp) {
        Some(s) => (s, false),
        None => match target {
            Some(t) => (t, true),
            None => (mp, false),
        },
    };

    let dx = goal[0] - mp[0];
    let dz = goal[2] - mp[2];
    let planar = (dx * dx + dz * dz).sqrt();
    let yaw = dx.atan2(dz); // matches facing_dir(yaw) = [sin, 0, cos]

    let mut move_x = 0.0;
    let mut move_z = 0.0;
    // Retreating: always move. Chasing: only close the gap when far.
    if (!chasing || planar > 1.6) && planar > 0.05 {
        move_x = dx / planar;
        move_z = dz / planar;
    }

    // Buttons, alternating press/release so a rising edge registers.
    let mut btn = 0u8;
    if brain.prev_emitted == 0 && chasing {
        let d = best.sqrt();
        if me.state.grounded && d < 2.2 && brain.chance(0.02) {
            btn = buttons::HEAVY;
        } else if d < 1.9 && brain.chance(0.15) {
            btn = buttons::LIGHT;
        } else if d > 3.5 && d < 8.0 && me.state.dash_cd == 0 && brain.chance(0.03) {
            btn = buttons::DASH;
        } else if brain.chance(0.01) {
            btn = buttons::JUMP;
        }
    }
    brain.prev_emitted = btn;

    PlayerInput {
        move_x,
        move_z,
        yaw,
        buttons: btn,
    }
}
