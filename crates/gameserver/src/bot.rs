//! Server-side practice bots. A bot is a room-level pseudo-player: each tick
//! its `BotBrain` produces a `PlayerInput` fed into the sim exactly like a
//! human's, so all round/scoring logic treats it uniformly. The brain's RNG
//! lives here (not in the sim), so sim determinism is untouched.
//!
//! Skill is data, not code: `think()` reads every knob from the
//! `DifficultyParams` preset for the brain's `BotDifficulty`, so all five
//! tiers share one decision ladder. Brains run inline in the room's 60 Hz
//! loop, so everything here must stay allocation-free and O(players + tiles
//! + projectiles) per tick.

use sim::GameSim;
use sim::arena::TileState;
use sim::character::{AttackPhase, attack_phase};
use sim::constants::{consts, dt};
use sim::types::{AttackKind, CharSnapshot, PlayerId, PlayerInput, buttons, powerup};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum BotDifficulty {
    Easy = 0,
    Medium = 1,
    Hard = 2,
    Expert = 3,
    Impossible = 4,
}

impl BotDifficulty {
    /// Clamping decode of the wire byte: out-of-range values become the top
    /// tier rather than a panic or a silent Easy.
    pub fn from_u8(v: u8) -> BotDifficulty {
        match v {
            0 => BotDifficulty::Easy,
            1 => BotDifficulty::Medium,
            2 => BotDifficulty::Hard,
            3 => BotDifficulty::Expert,
            _ => BotDifficulty::Impossible,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            BotDifficulty::Easy => "EASY",
            BotDifficulty::Medium => "MEDIUM",
            BotDifficulty::Hard => "HARD",
            BotDifficulty::Expert => "EXPERT",
            BotDifficulty::Impossible => "IMPOSSIBLE",
        }
    }

    pub fn params(self) -> &'static DifficultyParams {
        &PRESETS[self as usize]
    }
}

/// Every tier-tunable knob. Behavior code branches only through these fields,
/// never on the difficulty enum itself.
pub struct DifficultyParams {
    /// Ticks between decision refreshes (target, goal, aim error). 0 means
    /// the bot re-decides every tick; higher = slower "reaction time", since
    /// between refreshes it steers toward where things *were*.
    pub reaction_ticks: u16,
    /// Max |yaw error| in radians, resampled per decision.
    pub aim_jitter: f32,
    /// Per decision: abandon the fight and wander somewhere random.
    pub blunder_chance: f32,
    // Per-tick attack rolls (evaluated only when the range gate passes).
    pub light_chance: f32,
    pub heavy_chance: f32,
    pub dash_gap_chance: f32,
    pub jump_chance: f32,
    pub light_range: f32,
    pub heavy_range: f32,
    // Opportunity gates for reflexes, 0.0 = blind to them, 1.0 = never misses.
    pub dodge_skill: f32,
    pub recovery_skill: f32,
    pub ledge_care: f32,
    pub punish_skill: f32,
    // Tier capabilities.
    /// Panic mode: predict the ballistic landing point and start recovering
    /// *before* leaving the stage, spending dash + jumps aggressively.
    pub predictive_recovery: bool,
    pub predictive_aim: bool,
    pub seek_weapons: bool,
    pub target_weakest: bool,
    pub edge_side_positioning: bool,
    // Zero-risk play (the Impossible tier). All legal: these only change
    // which PlayerInputs get emitted.
    /// Walk out of a telegraphed hit when feet clear in time; the dash is
    /// spent only when walking can't make it — baiting a swing no longer
    /// drains the dash cooldown.
    pub evade_on_foot: bool,
    /// Rim-escape dashes and landing-spot avoidance: never stay pinned at
    /// the edge, never land at an edge-guarder's feet.
    pub cooldown_caution: bool,
    /// While the dash recharges, kite out of "dash-in + swing" range.
    /// Measured to LOSE duels (an equal-speed chaser can't be outrun, and
    /// the retreat phases forfeit punish windows) — kept as a knob, off by
    /// default everywhere.
    pub kite_on_cooldown: bool,
    /// Melee only into windows that cannot be punished: target launched,
    /// committed, or with their dash (their only i-frame) on cooldown.
    pub guaranteed_hits_only: bool,
    /// Strafe bullets on foot (they telegraph their whole flight); dash only
    /// for point-blank shots. Walk away from bomb blasts.
    pub bullet_evasion: bool,
}

/// Indexed by `BotDifficulty as usize`. Medium reproduces the original
/// single-tier bot's literals so the default feel is unchanged.
pub const PRESETS: [DifficultyParams; 5] = [
    // Easy: half-second reactions, sloppy aim, blunders, strolls off ledges.
    DifficultyParams {
        reaction_ticks: 24,
        aim_jitter: 0.35,
        blunder_chance: 0.25,
        light_chance: 0.08,
        heavy_chance: 0.01,
        dash_gap_chance: 0.01,
        jump_chance: 0.005,
        light_range: 1.7,
        heavy_range: 2.0,
        dodge_skill: 0.0,
        recovery_skill: 0.0,
        ledge_care: 0.5,
        punish_skill: 0.0,
        predictive_recovery: false,
        predictive_aim: false,
        seek_weapons: false,
        target_weakest: false,
        edge_side_positioning: false,
        evade_on_foot: false,
        cooldown_caution: false,
        kite_on_cooldown: false,
        guaranteed_hits_only: false,
        bullet_evasion: false,
    },
    // Medium: the original bot, plus a little launch recovery.
    DifficultyParams {
        reaction_ticks: 6,
        aim_jitter: 0.05,
        blunder_chance: 0.0,
        light_chance: 0.15,
        heavy_chance: 0.02,
        dash_gap_chance: 0.03,
        jump_chance: 0.01,
        light_range: 1.9,
        heavy_range: 2.2,
        dodge_skill: 0.0,
        recovery_skill: 0.35,
        ledge_care: 1.0,
        punish_skill: 0.0,
        predictive_recovery: false,
        predictive_aim: false,
        seek_weapons: false,
        target_weakest: false,
        edge_side_positioning: false,
        evade_on_foot: false,
        cooldown_caution: false,
        kite_on_cooldown: false,
        guaranteed_hits_only: false,
        bullet_evasion: false,
    },
    // Hard: fast, accurate, punishes, dodges half the time, grabs weapons.
    DifficultyParams {
        reaction_ticks: 2,
        aim_jitter: 0.02,
        blunder_chance: 0.0,
        light_chance: 0.45,
        heavy_chance: 0.10,
        dash_gap_chance: 0.10,
        jump_chance: 0.01,
        light_range: 2.2,
        heavy_range: 2.4,
        dodge_skill: 0.5,
        recovery_skill: 0.8,
        ledge_care: 1.0,
        punish_skill: 0.5,
        predictive_recovery: false,
        predictive_aim: true,
        seek_weapons: true,
        target_weakest: true,
        edge_side_positioning: false,
        evade_on_foot: false,
        cooldown_caution: false,
        kite_on_cooldown: false,
        guaranteed_hits_only: false,
        bullet_evasion: false,
    },
    // Expert: frame-perfect. Its one human-exploitable weakness is the dash
    // cooldown — bait the i-frame dodge, then punish the 45-tick recharge.
    DifficultyParams {
        reaction_ticks: 0,
        aim_jitter: 0.0,
        blunder_chance: 0.0,
        light_chance: 1.0,
        heavy_chance: 1.0,
        dash_gap_chance: 1.0,
        jump_chance: 0.0,
        light_range: 2.9,
        heavy_range: 3.1,
        dodge_skill: 1.0,
        recovery_skill: 1.0,
        ledge_care: 1.0,
        punish_skill: 1.0,
        predictive_recovery: true,
        predictive_aim: true,
        seek_weapons: true,
        target_weakest: true,
        edge_side_positioning: true,
        evade_on_foot: false,
        cooldown_caution: false,
        kite_on_cooldown: false,
        guaranteed_hits_only: false,
        bullet_evasion: false,
    },
    // Impossible: Expert's full aggression plus the defenses Expert lacks.
    // It ignores swings that can't reach it (baits do nothing), walks out
    // of ones that can while feet suffice, strafes bullets, escapes rim
    // pins through the attacker, steers launches away from edge-guarders,
    // and never falls. Same inputs, same physics, same cooldowns as
    // everyone else.
    DifficultyParams {
        reaction_ticks: 0,
        aim_jitter: 0.0,
        blunder_chance: 0.0,
        light_chance: 1.0,
        heavy_chance: 1.0,
        dash_gap_chance: 1.0,
        jump_chance: 0.0,
        light_range: 2.9,
        heavy_range: 3.1,
        dodge_skill: 1.0,
        recovery_skill: 1.0,
        ledge_care: 1.0,
        punish_skill: 1.0,
        predictive_recovery: true,
        predictive_aim: true,
        seek_weapons: true,
        target_weakest: true,
        edge_side_positioning: true,
        evade_on_foot: true,
        cooldown_caution: true,
        kite_on_cooldown: false,
        guaranteed_hits_only: false,
        bullet_evasion: true,
    },
];

/// What the bot decided to do the last time it "looked" at the world.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
enum Goal {
    /// Close on the target and fight.
    #[default]
    Chase,
    /// Off (or about to lose) solid ground: run to this tile center.
    Retreat([f32; 3]),
    /// Unarmed and a weapon is worth the detour.
    Pickup([f32; 3]),
    /// Blundered decision: shuffle in a random direction for a while.
    Wander([f32; 2]),
}

#[derive(Clone, Copy, Default)]
struct Decision {
    target: Option<PlayerId>,
    /// Target position at decision time. Movement and (non-predictive) aim
    /// use this snapshot, so slow-refresh tiers steer toward where the
    /// target *was* — that staleness is their reaction delay.
    target_pos: [f32; 3],
    goal: Goal,
    /// Aim error for this decision window, radians.
    yaw_err: f32,
}

pub struct BotBrain {
    rng: u64,
    /// Buttons emitted last tick — we release for one tick so the sim sees a
    /// fresh rising edge (`pressed = buttons & !prev`) on the next press.
    prev_emitted: u8,
    difficulty: BotDifficulty,
    decision: Decision,
    /// Ticks until the next decision refresh.
    refresh_in: u16,
    /// Committed strafe side while evading a projectile (+1/-1, 0 = unset).
    /// Re-picking every tick near the corridor axis would oscillate in place.
    evade_sign: i8,
}

impl BotBrain {
    pub fn new(id: PlayerId, difficulty: BotDifficulty) -> BotBrain {
        BotBrain {
            rng: 0x9E37_79B9_7F4A_7C15 ^ (id as u64 + 1).wrapping_mul(0xD1B5_4A32_D192_ED03),
            prev_emitted: 0,
            difficulty,
            decision: Decision::default(),
            refresh_in: 0,
            evade_sign: 0,
        }
    }

    pub fn difficulty(&self) -> BotDifficulty {
        self.difficulty
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

    fn unit(&mut self) -> f32 {
        self.next() as f32 / u32::MAX as f32
    }

    fn chance(&mut self, p: f32) -> bool {
        // Always roll (keeps the stream uniform); p >= 1 must never fail.
        let u = self.unit();
        p >= 1.0 || u < p
    }

    /// Refresh target / goal / aim error. Called every `reaction_ticks`.
    fn decide(&mut self, sim: &GameSim, id: PlayerId, me: &CharSnapshot) -> Decision {
        let p = self.difficulty.params();
        let mp = me.pos;

        // Target: nearest alive opponent — or, for tiers that hunt kills, the
        // most damaged one (damage is the KO currency: high % dies to one hit).
        let mut target: Option<PlayerId> = None;
        let mut target_pos = mp;
        let mut best_d2 = f32::MAX;
        let mut best_dmg = 0u16;
        for (&oid, o) in sim.players.iter() {
            if oid == id || !o.alive {
                continue;
            }
            let Some(snap) = sim.snapshot(oid) else {
                continue;
            };
            let d2 = dist2(mp, snap.pos);
            let better = if p.target_weakest {
                target.is_none()
                    || snap.damage > best_dmg
                    || (snap.damage == best_dmg && d2 < best_d2)
            } else {
                d2 < best_d2
            };
            if better {
                target = Some(oid);
                target_pos = snap.pos;
                best_d2 = d2;
                best_dmg = snap.damage;
            }
        }

        // Goal ladder: survival first, then greed, then the fight.
        let mut goal = Goal::Chase;
        if let Some(safe) = safe_tile_center(sim, mp) {
            if self.chance(p.ledge_care) {
                goal = Goal::Retreat(safe);
            }
        }
        if goal == Goal::Chase && p.seek_weapons && me.state.powerup == powerup::NONE {
            let mut pk: Option<[f32; 3]> = None;
            let mut pk_d2 = f32::MAX;
            for pu in sim.pickups.iter() {
                let d2 = dist2(mp, pu.pos);
                if d2 < pk_d2 {
                    pk_d2 = d2;
                    pk = Some(pu.pos);
                }
            }
            // Worth a detour only when it's not across the map and not much
            // farther than the fight we'd be walking away from. The top
            // tier detours much more eagerly: it strafes bullets, so arming
            // itself is a pure asymmetric payoff.
            if let Some(pos) = pk {
                let (max_d2, ratio) = if p.bullet_evasion {
                    (15.0 * 15.0, 6.25)
                } else {
                    (12.0 * 12.0, 2.25)
                };
                if pk_d2 < max_d2 && (target.is_none() || pk_d2 < best_d2 * ratio) {
                    goal = Goal::Pickup(pos);
                }
            }
        }
        if goal == Goal::Chase && self.chance(p.blunder_chance) {
            let a = self.unit() * std::f32::consts::TAU;
            goal = Goal::Wander([a.sin(), a.cos()]);
        }
        let yaw_err = (self.unit() * 2.0 - 1.0) * p.aim_jitter;

        Decision {
            target,
            target_pos,
            goal,
            yaw_err,
        }
    }
}

fn dist2(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dz = a[2] - b[2];
    dx * dx + dz * dz
}

fn dist3(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

/// Is the tile under `pos` solid? (Cheap scan; the tile grid is small.)
fn on_solid(sim: &GameSim, pos: [f32; 3]) -> bool {
    let size = consts().arena_tile_size;
    let gx = (pos[0] / size).round() as i32;
    let gz = (pos[2] / size).round() as i32;
    sim.arena
        .tiles
        .iter()
        .any(|t| t.gx == gx && t.gz == gz && t.state == TileState::Solid)
}

/// If the tile under `pos` is not solid, return the nearest solid tile center
/// (retreat goal); otherwise `None` (standing on safe ground).
fn safe_tile_center(sim: &GameSim, pos: [f32; 3]) -> Option<[f32; 3]> {
    if on_solid(sim, pos) {
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

/// Body-center height when standing on a tile (tile tops are y = 0, capsule
/// radius 0.45 + half-height 0.55).
const REST_Y: f32 = 1.0;

/// Zero-input ballistic landing point: where we come back down to standing
/// height if we do nothing from here. Panic mode uses it to spot a doomed
/// trajectory while still above the stage.
fn predict_landing(pos: [f32; 3], vel: [f32; 3]) -> [f32; 3] {
    let g = -consts().gravity; // positive down
    let h = pos[1] - REST_Y;
    let t = if h <= 0.0 && vel[1] <= 0.0 {
        0.0 // already at/below deck height and sinking: judge where we are
    } else {
        // h + vy*t - g/2*t^2 = 0, positive root. A negative discriminant
        // (rising from below, never reaching deck height) degrades to the
        // apex time.
        let disc = vel[1] * vel[1] + 2.0 * g * h;
        (vel[1] + disc.max(0.0).sqrt()) / g
    };
    [pos[0] + vel[0] * t, REST_Y, pos[2] + vel[2] * t]
}

/// Where the current goal wants us even mid-air: the weapon we're hopping
/// to, or a chase target standing on (possibly another) piece of ground.
/// None when there's nothing worth steering a flight toward.
fn goal_intent(sim: &GameSim, d: &Decision) -> Option<[f32; 3]> {
    match d.goal {
        Goal::Pickup(pk) => Some(pk),
        Goal::Chase if d.target.is_some() && on_solid(sim, d.target_pos) => Some(d.target_pos),
        _ => None,
    }
}

/// The platform to boost toward in a panic: the solid tile nearest to where
/// the trajectory is heading, tie-broken toward us. Mid island-hop (for a
/// weapon or a camping opponent), prefer the intent's island so panic
/// doesn't cancel the crossing.
fn panic_target(
    sim: &GameSim,
    id: PlayerId,
    mp: [f32; 3],
    landing: [f32; 3],
    pk: Option<[f32; 3]>,
    avoid_guards: bool,
) -> Option<[f32; 3]> {
    let mut best = f32::MAX;
    let mut center: Option<[f32; 3]> = None;
    let mut pk_best = f32::MAX;
    let mut pk_center: Option<[f32; 3]> = None;
    for t in sim.arena.tiles.iter() {
        if t.state != TileState::Solid {
            continue;
        }
        let ctr = t.center();
        let mut score = dist2(landing, ctr) + 0.5 * dist2(mp, ctr);
        // Edge-guarders camp re-entry points: recovering into a tile next
        // to an able opponent is a free juggle hit for them. Steer wide.
        // (A tier skill — lower tiers recover naively.)
        for (&oid, o) in sim.players.iter() {
            if !avoid_guards {
                break;
            }
            if oid == id || !o.alive || o.state.launched > 0 {
                continue;
            }
            if let Some(os) = sim.snapshot(oid) {
                let d2 = dist2(ctr, os.pos);
                if d2 < 25.0 {
                    score += (25.0 - d2) * 1.8;
                }
            }
        }
        if score < best {
            best = score;
            center = Some(ctr);
        }
        if let Some(pk) = pk {
            let d = dist2(pk, ctr);
            if d < pk_best {
                pk_best = d;
                pk_center = Some(ctr);
            }
        }
    }
    if let (Some(pc), Some(c)) = (pk_center, center) {
        if dist2(mp, pc).sqrt() <= dist2(mp, c).sqrt() + 6.0 {
            return Some(pc);
        }
    }
    center
}

/// A telegraphed incoming hit and what escaping it takes.
struct Threat {
    /// Unit xz direction from the threat toward us.
    away: [f32; 2],
    /// Perpendicular escape geometry (melee swings, bullets) vs radial
    /// (bomb blasts).
    perp: bool,
    /// Ticks before it can actually hurt us.
    ticks_left: f32,
    /// Clearance (units) still needed to be safely outside it.
    escape_dist: f32,
    /// Projectile threats gate foot escapes on `bullet_evasion`; melee
    /// threats on `evade_on_foot`.
    projectile: bool,
}

/// Scan for whatever is about to hit us: opponents mid-windup in reach, or
/// projectiles converging on our position.
fn find_threat(sim: &GameSim, id: PlayerId, mp: [f32; 3]) -> Option<Threat> {
    let c = consts();

    for (&oid, o) in sim.players.iter() {
        if oid == id || !o.alive {
            continue;
        }
        if attack_phase(&o.state) != AttackPhase::Windup {
            continue;
        }
        let Some(os) = sim.snapshot(oid) else {
            continue;
        };
        let (reach, windup) = match o.state.attack.kind {
            AttackKind::Heavy => (c.heavy_reach + c.heavy_hit_radius, c.heavy_windup_ticks),
            AttackKind::AirLight => (c.air_light_hit_radius, c.air_light_windup_ticks),
            _ => (c.light_reach + c.light_hit_radius, c.light_windup_ticks),
        };
        let dx = mp[0] - os.pos[0];
        let dz = mp[2] - os.pos[2];
        let d = (dx * dx + dz * dz).sqrt();
        if d < reach + c.player_radius + 0.7 {
            let ticks_left = windup.saturating_sub(o.state.attack.ticks) as f32;
            // Clearance vs the actual hit volume, counting the attacker
            // drifting toward us during the rest of the windup.
            let closing = if d > 0.05 {
                ((dx * os.vel[0] + dz * os.vel[2]) / d).max(0.0)
            } else {
                0.0
            };
            let escape_dist = (reach + c.player_radius + 0.2) - d + closing * ticks_left * dt();
            let away = if d < 0.05 {
                [1.0, 0.0]
            } else {
                [dx / d, dz / d]
            };
            return Some(Threat {
                away,
                perp: true,
                ticks_left,
                escape_dist,
                projectile: false,
            });
        }
    }

    for pr in sim.projectiles.iter() {
        if pr.owner == id {
            continue;
        }
        let rx = mp[0] - pr.pos.x;
        let rz = mp[2] - pr.pos.z;
        let d2 = rx * rx + rz * rz;
        if d2 > 15.0 * 15.0 {
            continue;
        }
        let bomb = pr.kind == powerup::BOMB;
        let danger = if bomb { c.bomb_radius + 0.6 } else { 1.2 };
        let vx = pr.vel.x;
        let vz = pr.vel.z;
        let v2 = vx * vx + vz * vz;
        // Closest planar approach within the next half second.
        let t = if v2 < 1e-3 {
            0.0
        } else {
            ((rx * vx + rz * vz) / v2).clamp(0.0, 0.5)
        };
        let cx = rx - vx * t;
        let cz = rz - vz * t;
        let miss = (cx * cx + cz * cz).sqrt();
        if miss < danger {
            let d = d2.sqrt().max(0.05);
            // Bombs hurt when the fuse ends; bullets at closest approach.
            let ticks_left = if bomb { pr.ttl as f32 } else { t / dt() };
            return Some(Threat {
                away: [rx / d, rz / d],
                perp: !bomb,
                ticks_left,
                escape_dist: danger - miss,
                projectile: true,
            });
        }
    }
    None
}

/// Yaw that leads a straight-line target so a `speed` projectile intercepts
/// it: smallest positive root of |rel + vel*t| = speed*t.
fn gun_intercept(mp: [f32; 3], tp: [f32; 3], tv: [f32; 3], speed: f32) -> Option<f32> {
    let rx = tp[0] - mp[0];
    let rz = tp[2] - mp[2];
    let (vx, vz) = (tv[0], tv[2]);
    let a = vx * vx + vz * vz - speed * speed;
    let b = 2.0 * (rx * vx + rz * vz);
    let c = rx * rx + rz * rz;
    let t = if a.abs() < 1e-4 {
        if b.abs() < 1e-4 {
            return None;
        }
        -c / b
    } else {
        let disc = b * b - 4.0 * a * c;
        if disc < 0.0 {
            return None;
        }
        let sq = disc.sqrt();
        let t1 = (-b - sq) / (2.0 * a);
        let t2 = (-b + sq) / (2.0 * a);
        let t = if t1 > 0.0 && (t1 < t2 || t2 <= 0.0) {
            t1
        } else {
            t2
        };
        t
    };
    // Beyond the bullet's lifetime there is no shot.
    if t <= 0.0 || t > 1.2 {
        return None;
    }
    Some((rx + vx * t).atan2(rz + vz * t))
}

/// Compute this tick's input for the bot with id `id`.
pub fn think(sim: &GameSim, id: PlayerId, brain: &mut BotBrain) -> PlayerInput {
    let c = consts();
    let p = brain.difficulty.params();
    let Some(me) = sim.snapshot(id) else {
        return PlayerInput::default();
    };
    if !me.alive {
        brain.prev_emitted = 0;
        brain.refresh_in = 0;
        return PlayerInput::default();
    }
    let mp = me.pos;
    let over_void = safe_tile_center(sim, mp);

    // ---- decision refresh: reaction time = how often the bot "looks" ----
    let target_gone = match brain.decision.target {
        Some(tid) => sim.snapshot(tid).map(|t| !t.alive).unwrap_or(true),
        None => false,
    };
    if brain.refresh_in == 0 || target_gone {
        brain.decision = brain.decide(sim, id, &me);
        brain.refresh_in = p.reaction_ticks;
    }
    brain.refresh_in = brain.refresh_in.saturating_sub(1);

    // ---- reflex: DI while launched (buttons are dead; steering is all) ----
    if me.state.launched > 0 {
        brain.prev_emitted = 0;
        if !brain.chance(p.recovery_skill) {
            return PlayerInput::default();
        }
        // Steer the trajectory back over ground. Panic tiers aim at where
        // the launch is actually taking them and DI against the overshoot;
        // others head for the tile below (or mid-arena).
        let (mut dx, mut dz) = if p.predictive_recovery {
            let landing = predict_landing(mp, me.vel);
            // No chase intent here: steering a LAUNCH toward the opponent's
            // ground means landing at the edge-guarder's feet. Safety only.
            match panic_target(sim, id, mp, landing, None, p.cooldown_caution) {
                Some(g) if !on_solid(sim, landing) => (g[0] - landing[0], g[2] - landing[2]),
                _ => (0.0, 0.0), // trajectory already lands safe: ride it out
            }
        } else {
            let g = over_void.unwrap_or([0.0; 3]);
            (g[0] - mp[0], g[2] - mp[2])
        };
        // Zero-risk tiers also refuse to land at an edge-guarder's feet:
        // we can't act until the launch ends, so a landing inside their
        // reach is a free juggle hit. DI away from whoever camps it.
        if p.cooldown_caution {
            let landing = predict_landing(mp, me.vel);
            for (&oid, o) in sim.players.iter() {
                if oid == id || !o.alive || o.state.launched > 0 {
                    continue;
                }
                let Some(os) = sim.snapshot(oid) else {
                    continue;
                };
                if dist2(landing, os.pos) < 4.5 * 4.5 {
                    let ax = landing[0] - os.pos[0];
                    let az = landing[2] - os.pos[2];
                    let an = (ax * ax + az * az).sqrt().max(0.05);
                    dx += ax / an * 2.0;
                    dz += az / an * 2.0;
                }
            }
        }
        let n = (dx * dx + dz * dz).sqrt();
        if n < 0.05 {
            return PlayerInput::default();
        }
        return PlayerInput {
            move_x: dx / n,
            move_z: dz / n,
            yaw: dx.atan2(dz),
            buttons: 0,
        };
    }

    // ---- reflex: air recovery / panic (boost back to solid ground) ----
    // Panic tiers trigger as soon as the ballistic landing point misses the
    // stage — while still above it; reactive tiers wait until they're past
    // the edge. The steer vector differs too: panic pushes against the
    // *landing* overshoot, reactive walks toward the tile from where it is.
    let panic_steer: Option<([f32; 2], bool)> = if me.state.grounded {
        None
    } else if p.predictive_recovery {
        let landing = predict_landing(mp, me.vel);
        if on_solid(sim, landing) {
            None
        } else {
            let intent = goal_intent(sim, &brain.decision);
            panic_target(sim, id, mp, landing, intent, p.cooldown_caution)
                .map(|g| ([g[0] - landing[0], g[2] - landing[2]], true))
        }
    } else if over_void.is_some() {
        let g = match brain.decision.goal {
            // Mid island-hop: keep flying to the weapon, not back to shore.
            Goal::Pickup(pk) => pk,
            _ => over_void.unwrap(),
        };
        Some(([g[0] - mp[0], g[2] - mp[2]], false))
    } else {
        None
    };
    if let Some(([dx, dz], panicking)) = panic_steer {
        if brain.chance(p.recovery_skill) {
            let n = (dx * dx + dz * dz).sqrt().max(0.05);
            let mut btn = 0u8;
            let busy = me.state.slamming
                || me.state.dash_ticks > 0
                || attack_phase(&me.state) != AttackPhase::None;
            if brain.prev_emitted == 0 && !busy {
                let falling = me.vel[1] < 0.5;
                if panicking {
                    // Spend everything, biggest boost first: dash covers the
                    // most ground and pauses gravity, so don't hoard it. Jump
                    // at the fall's peak — or instantly once below deck level.
                    let urgent = mp[1] < REST_Y && me.vel[1] < 2.0;
                    if me.state.dash_cd == 0 && n > 2.5 {
                        btn = buttons::DASH;
                    } else if (falling || urgent) && me.state.jump_count < c.max_jumps {
                        btn = buttons::JUMP;
                    } else if falling && me.state.dash_cd == 0 && n > 1.0 {
                        btn = buttons::DASH;
                    }
                } else if falling {
                    // Reactive tiers: double jump at the peak, dash as backup.
                    if me.state.jump_count < c.max_jumps {
                        btn = buttons::JUMP;
                    } else if me.state.dash_cd == 0 && n > 1.5 {
                        btn = buttons::DASH;
                    }
                }
            }
            brain.prev_emitted = btn;
            return PlayerInput {
                move_x: dx / n,
                move_z: dz / n,
                yaw: dx.atan2(dz),
                buttons: btn,
            };
        }
    }

    // ---- reflex: evade an incoming hit (feet first, then dash i-frames) ----
    let can_act = !me.state.slamming
        && me.state.dash_ticks == 0
        && attack_phase(&me.state) == AttackPhase::None;
    if can_act && brain.prev_emitted == 0 && brain.chance(p.dodge_skill) {
        let th = find_threat(sim, id, mp);
        if th.is_none() {
            brain.evade_sign = 0;
        }
        if let Some(th) = th {
            // A swing that cannot actually connect deserves no response at
            // all: don't dash, don't retreat, keep fighting. Baits do
            // nothing to tiers that can read them.
            if p.evade_on_foot && !th.projectile && th.escape_dist <= 0.0 {
                brain.evade_sign = 0;
            } else {
                // Walking out costs nothing: tiers that can, prefer it whenever
                // feet clear in time — a baited swing then wastes nothing.
                let foot_flag = if th.projectile {
                    p.bullet_evasion
                } else {
                    p.evade_on_foot
                };
                if foot_flag && th.escape_dist < th.ticks_left * dt() * c.move_speed * 0.85 {
                    let dir = if th.projectile && th.perp {
                        // Sidestep the bullet corridor. Commit to one side for
                        // the whole evasion — re-picking near the corridor axis
                        // would oscillate in place until the bullet arrives.
                        if brain.evade_sign == 0 {
                            let (px, pz) = (-th.away[1], th.away[0]);
                            brain.evade_sign = if px * mp[0] + pz * mp[2] <= 0.0 {
                                1
                            } else {
                                -1
                            };
                        }
                        let s = brain.evade_sign as f32;
                        [-th.away[1] * s, th.away[0] * s]
                    } else {
                        th.away
                    };
                    brain.prev_emitted = 0;
                    return PlayerInput {
                        move_x: dir[0],
                        move_z: dir[1],
                        yaw: dir[0].atan2(dir[1]),
                        buttons: 0,
                    };
                }
                if me.state.dash_cd == 0 {
                    // Never dash off the stage: eating the hit is survivable, a
                    // self-ring-out is not. Check where the dash actually ends,
                    // with margin so we don't stop half-off a rim tile.
                    let dash_len = c.dash_speed * c.dash_ticks as f32 * dt() * 1.15;
                    let safe = |dir: [f32; 2]| {
                        on_solid(
                            sim,
                            [mp[0] + dir[0] * dash_len, mp[1], mp[2] + dir[1] * dash_len],
                        )
                    };
                    let mut pick: Option<[f32; 2]> = None;
                    if th.perp {
                        // Of the two perpendiculars, prefer the mid-arena drift.
                        let (px, pz) = (-th.away[1], th.away[0]);
                        let first = if px * mp[0] + pz * mp[2] <= 0.0 {
                            [px, pz]
                        } else {
                            [-px, -pz]
                        };
                        for cand in [first, [-first[0], -first[1]]] {
                            if safe(cand) {
                                pick = Some(cand);
                                break;
                            }
                        }
                    } else if safe(th.away) {
                        pick = Some(th.away);
                    }
                    if let Some([ex, ez]) = pick {
                        brain.prev_emitted = buttons::DASH;
                        return PlayerInput {
                            move_x: ex,
                            move_z: ez,
                            yaw: ex.atan2(ez),
                            buttons: buttons::DASH,
                        };
                    }
                }
            }
        }
    }

    // ---- positioning: never stay pinned against the rim ----
    // An opponent holding the center side of us at the edge turns every
    // retreat into a corner. The escape is straight through them: the dash
    // is fully intangible, so burn it to trade places and take the center.
    if p.cooldown_caution && can_act && me.state.dash_cd == 0 && brain.prev_emitted == 0 {
        let my_r2 = mp[0] * mp[0] + mp[2] * mp[2];
        if my_r2 > 5.5 * 5.5 {
            let pinned = sim.players.iter().any(|(&oid, o)| {
                if oid == id || !o.alive || o.state.launched > 0 {
                    return false;
                }
                let Some(os) = sim.snapshot(oid) else {
                    return false;
                };
                let or2 = os.pos[0] * os.pos[0] + os.pos[2] * os.pos[2];
                or2 < my_r2 && dist2(mp, os.pos) < 5.0 * 5.0
            });
            if pinned {
                let n = my_r2.sqrt();
                let dir = [-mp[0] / n, -mp[2] / n];
                brain.prev_emitted = buttons::DASH;
                return PlayerInput {
                    move_x: dir[0],
                    move_z: dir[1],
                    yaw: dir[0].atan2(dir[1]),
                    buttons: buttons::DASH,
                };
            }
        }
    }

    // ---- caution: while the dash recharges, stay out of dash-in range ----
    // A dash-in (~3.3 u) plus a swing (~3 u) is the only way to force melee
    // on us; with our i-frame dash down we refuse to be inside that
    // envelope. The margin grows with our damage (launches get bigger).
    if p.kite_on_cooldown && me.state.dash_cd > 0 && can_act && me.state.powerup != powerup::GUN {
        let danger_r = 7.5 + me.damage as f32 * 0.02;
        let mut nearest: Option<([f32; 3], f32)> = None;
        for (&oid, o) in sim.players.iter() {
            // Launched or mid-recovery opponents are punish windows, not
            // threats — never kite through our own free hits.
            if oid == id
                || !o.alive
                || o.state.launched > 0
                || attack_phase(&o.state) == AttackPhase::Recovery
            {
                continue;
            }
            let Some(os) = sim.snapshot(oid) else {
                continue;
            };
            let d = dist2(mp, os.pos).sqrt();
            if nearest.map(|(_, nd)| d < nd).unwrap_or(true) {
                nearest = Some((os.pos, d));
            }
        }
        if let Some((opos, od)) = nearest {
            if od < danger_r {
                let d = od.max(0.05);
                let away = [(mp[0] - opos[0]) / d, (mp[2] - opos[2]) / d];
                // Retreat along the stage: straight back if solid, else curve
                // around them (center-preferring rotations), else mid-arena.
                let probe = |dir: [f32; 2]| {
                    on_solid(sim, [mp[0] + dir[0] * 1.6, mp[1], mp[2] + dir[1] * 1.6])
                };
                let centerness = |dir: [f32; 2]| -(dir[0] * mp[0] + dir[1] * mp[2]);
                let rot45 = |dir: [f32; 2], s: f32| {
                    [dir[0] * 0.7071 - dir[1] * s, dir[0] * s + dir[1] * 0.7071]
                };
                let (r1, r2) = (rot45(away, 0.7071), rot45(away, -0.7071));
                let (r1, r2) = if centerness(r1) >= centerness(r2) {
                    (r1, r2)
                } else {
                    (r2, r1)
                };
                let (p1, p2) = ([-away[1], away[0]], [away[1], -away[0]]);
                let (p1, p2) = if centerness(p1) >= centerness(p2) {
                    (p1, p2)
                } else {
                    (p2, p1)
                };
                // Near the rim, kiting straight back gets us cornered (the
                // retreat arc loses radial speed to a straight-line chaser):
                // prefer cutting toward open ground first.
                let rim = mp[0] * mp[0] + mp[2] * mp[2] > 6.0 * 6.0;
                let order = if rim {
                    [r1, p1, away, r2, p2]
                } else {
                    [away, r1, r2, p1, p2]
                };
                let mut dir = [0.0, 0.0];
                let mut found = false;
                for cand in order {
                    if probe(cand) {
                        dir = cand;
                        found = true;
                        break;
                    }
                }
                if !found {
                    let n = (mp[0] * mp[0] + mp[2] * mp[2]).sqrt().max(0.05);
                    dir = [-mp[0] / n, -mp[2] / n];
                }
                brain.prev_emitted = 0;
                // Face the opponent while backpedaling: punish-ready.
                let fx = opos[0] - mp[0];
                let fz = opos[2] - mp[2];
                return PlayerInput {
                    move_x: dir[0],
                    move_z: dir[1],
                    yaw: fx.atan2(fz),
                    buttons: 0,
                };
            }
        }
    }

    // ---- fight / movement ----
    let tsnap = brain
        .decision
        .target
        .and_then(|tid| sim.snapshot(tid))
        .filter(|t| t.alive);
    let chasing = brain.decision.goal == Goal::Chase && tsnap.is_some();

    let mut goal_pos = match brain.decision.goal {
        Goal::Retreat(g) | Goal::Pickup(g) => g,
        Goal::Wander(d) => [mp[0] + d[0] * 3.0, mp[1], mp[2] + d[1] * 3.0],
        Goal::Chase => {
            if chasing {
                brain.decision.target_pos
            } else {
                mp // nobody left to fight
            }
        }
    };
    if chasing && p.edge_side_positioning {
        // Approach from the arena-center side: knockback points attacker ->
        // target, so every hit we land pushes them toward the void.
        let tx = goal_pos[0];
        let tz = goal_pos[2];
        let n = (tx * tx + tz * tz).sqrt();
        if n > 1.0 {
            let gap = 2.4f32.min(n);
            goal_pos[0] -= tx / n * gap;
            goal_pos[2] -= tz / n * gap;
        }
    }

    let mut dx = goal_pos[0] - mp[0];
    let mut dz = goal_pos[2] - mp[2];
    let mut planar = (dx * dx + dz * dz).sqrt();
    if chasing && planar < 0.3 {
        // Reached the approach point but not the target: head straight in.
        let t = tsnap.as_ref().unwrap();
        dx = t.pos[0] - mp[0];
        dz = t.pos[2] - mp[2];
        planar = (dx * dx + dz * dz).sqrt();
    }

    let mut yaw = dx.atan2(dz); // matches facing_dir(yaw) = [sin, 0, cos]
    let mut in_light = false;
    let mut in_heavy = false;
    let mut d_true = f32::MAX;
    // Zero-risk tiers: true only when hitting the target cannot be punished.
    let mut risk_free = true;
    let mut standoff = false;
    let mut committed = false;

    if chasing {
        let t = tsnap.as_ref().unwrap();
        d_true = dist2(mp, t.pos).sqrt();
        let vulnerable = t.state.dash_ticks == 0 && t.state.invuln == 0;
        // Committed: they cannot land a NEW hit before a light pressed right
        // now connects — any recovery, or a heavy windup with more ticks
        // left than our light needs. (An idle opponent can press the same
        // tick we do and trade, so idle is never a free hit.)
        let ph_t = attack_phase(&t.state);
        committed = ph_t == AttackPhase::Recovery
            || (t.state.attack.kind == AttackKind::Heavy
                && ph_t == AttackPhase::Windup
                && c.heavy_windup_ticks.saturating_sub(t.state.attack.ticks)
                    > c.light_windup_ticks + 1);
        if p.guaranteed_hits_only {
            // Third free window: pressing from OUTSIDE their instant-counter
            // reach. They can only trade by pressing within our windup, and
            // from out there their swing can't touch us — while our own
            // approach-velocity lead still makes ours connect.
            let closing = {
                let cx = mp[0] - t.pos[0];
                let cz = mp[2] - t.pos[2];
                let n = (cx * cx + cz * cz).sqrt().max(0.05);
                ((cx * t.vel[0] + cz * t.vel[2]) / n).max(0.0)
            };
            let counter_reach = c.light_reach
                + c.light_hit_radius
                + c.player_radius
                + closing * (c.light_windup_ticks as f32) * dt()
                + 0.15;
            risk_free = t.state.launched > 0 || committed || d_true > counter_reach;
            standoff = !risk_free;
        }
        if p.predictive_aim {
            // Lead by the light windup on BOTH sides: where they will be and
            // where we will be when the active window opens — so a press
            // mid-approach connects on its first active frame.
            let lead = c.light_windup_ticks as f32 * dt();
            let pl = [
                t.pos[0] + t.vel[0] * lead,
                t.pos[1] + t.vel[1] * lead,
                t.pos[2] + t.vel[2] * lead,
            ];
            let ml = [mp[0] + me.vel[0] * lead, mp[1], mp[2] + me.vel[2] * lead];
            let adx = pl[0] - ml[0];
            let adz = pl[2] - ml[2];
            if adx.abs() + adz.abs() > 1e-3 {
                yaw = adx.atan2(adz);
            }
            // Exact hit-volume check at the moment the swing goes active.
            let margin = c.player_radius - 0.1;
            if me.state.grounded {
                let hc = [
                    ml[0] + yaw.sin() * c.light_reach,
                    ml[1],
                    ml[2] + yaw.cos() * c.light_reach,
                ];
                in_light = dist3(hc, pl) < c.light_hit_radius + margin;
            } else {
                // Airborne LIGHT is a 360° spin centered on us.
                in_light = dist3(ml, pl) < c.air_light_hit_radius + margin;
            }
            // Heavy only into kill windows. The top tier additionally reads
            // whether the target can dash out of the 18-tick windup: it
            // heavies earlier (40%) but only opponents whose i-frame dash
            // is down or who are already launched.
            let kill_window = if p.cooldown_caution {
                t.state.launched > 0 || (t.damage >= 40 && t.state.dash_cd > 0)
            } else {
                t.damage >= 55 || t.state.launched > 0
            };
            in_heavy = me.state.grounded
                && vulnerable
                && kill_window
                && d_true > 0.6
                && d_true < c.heavy_reach + c.heavy_hit_radius;
            if !vulnerable {
                in_light = false;
            }
            if me.state.powerup == powerup::GUN {
                if let Some(lead_yaw) = gun_intercept(mp, t.pos, t.vel, c.gun_speed) {
                    yaw = lead_yaw;
                }
            }
        } else {
            in_light = d_true < p.light_range;
            in_heavy = me.state.grounded && d_true < p.heavy_range;
        }
        if standoff {
            // No free window: don't swing, hold spacing and wait for one.
            in_light = false;
            in_heavy = false;
        }
    }
    yaw += brain.decision.yaw_err;

    // Movement gate: retreat/pickup/wander always walk; chasing holds spacing.
    let mut want_move = planar > 0.05;
    if chasing {
        let t = tsnap.as_ref().unwrap();
        if standoff && me.state.powerup != powerup::GUN {
            // Wait just outside their swing envelope (their light hit sphere
            // reaches ~3.05 u): close enough to pounce on a window, far
            // enough that only a dash-in reaches us — which we i-frame.
            if d_true < 4.2 {
                dx = mp[0] - t.pos[0];
                dz = mp[2] - t.pos[2];
                planar = (dx * dx + dz * dz).sqrt().max(0.05);
                let back = [mp[0] + dx / planar * 1.5, mp[1], mp[2] + dz / planar * 1.5];
                if !on_solid(sim, back) {
                    // Cornered against the edge: circle around them instead.
                    let (px, pz) = (-dz / planar, dx / planar);
                    let toward_c = if px * mp[0] + pz * mp[2] <= 0.0 {
                        (px, pz)
                    } else {
                        (-px, -pz)
                    };
                    dx = toward_c.0;
                    dz = toward_c.1;
                    planar = 1.0;
                }
                want_move = true;
            } else {
                want_move = d_true > 5.5;
            }
        } else if p.predictive_aim && me.state.powerup == powerup::GUN {
            // Kite: hold the firing band instead of brawling.
            if d_true < 4.0 {
                dx = mp[0] - t.pos[0];
                dz = mp[2] - t.pos[2];
                planar = (dx * dx + dz * dz).sqrt().max(0.05);
                let back = [mp[0] + dx / planar * 1.5, mp[1], mp[2] + dz / planar * 1.5];
                // Don't backpedal off the ledge; stand and shoot instead.
                want_move = on_solid(sim, back);
            } else {
                want_move = d_true > 9.0;
            }
        } else if p.predictive_aim {
            want_move = !in_light;
        } else {
            want_move = planar > 0.85 * p.light_range;
        }
    }
    let (mvx, mvz) = if want_move && planar > 0.05 {
        (dx / planar, dz / planar)
    } else {
        (0.0, 0.0)
    };

    // ---- hop initiation: jump BEFORE walking off toward another landmass --
    // A full ground jump + air jump + dash crosses an island gap; walking
    // off first wastes the strongest jump. Panic mode steers the flight.
    let mut hop_btn = 0u8;
    if p.predictive_recovery
        && me.state.grounded
        && can_act
        && brain.prev_emitted == 0
        && (mvx != 0.0 || mvz != 0.0)
    {
        if let Some(intent) = goal_intent(sim, &brain.decision) {
            let ahead = [mp[0] + mvx * 1.3, mp[1], mp[2] + mvz * 1.3];
            if dist2(mp, intent) > 3.0 * 3.0 && !on_solid(sim, ahead) {
                hop_btn = buttons::JUMP;
            }
        }
    }

    // ---- buttons, alternating press/release so rising edges register ----
    let mut btn = 0u8;
    if brain.prev_emitted == 0 && can_act && chasing {
        let t = tsnap.as_ref().unwrap();
        let ranged = me.state.powerup == powerup::GUN || me.state.powerup == powerup::BOMB;
        if ranged {
            let band = if me.state.powerup == powerup::GUN {
                d_true > 2.5 && d_true < 14.0
            } else {
                d_true > 4.0 && d_true < 9.5
            };
            if me.state.fire_cd == 0 && band {
                btn = buttons::LIGHT;
            }
        } else {
            let vulnerable = t.state.dash_ticks == 0 && t.state.invuln == 0;
            let veto = p.predictive_aim && !vulnerable;
            // A committed opponent (see the fight-context block) is a free hit.
            if committed && !veto && d_true < p.light_range + 0.4 && brain.chance(p.punish_skill) {
                btn = buttons::LIGHT;
            } else if in_heavy && brain.chance(p.heavy_chance) {
                btn = buttons::HEAVY;
            } else if in_light && !veto && brain.chance(p.light_chance) {
                btn = buttons::LIGHT;
            } else if d_true > 3.5
                && d_true < 8.0
                && me.state.dash_cd == 0
                // For zero-risk tiers risk_free is the strict no-trade
                // window (committed/launched), so bursting in with the dash
                // converts the window before it closes; the hit launches
                // them, which covers our own cooldown afterwards.
                && risk_free
                && brain.chance(p.dash_gap_chance)
                && on_solid(sim, t.pos)
            {
                btn = buttons::DASH;
            } else if brain.chance(p.jump_chance) {
                btn = buttons::JUMP;
            }
        }
    }
    if btn == 0 {
        btn = hop_btn;
    }
    brain.prev_emitted = btn;

    PlayerInput {
        move_x: mvx,
        move_z: mvz,
        yaw,
        buttons: btn,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim::types::SimEvent;
    use std::collections::BTreeMap;

    /// Fresh combat sim with players placed and spawn invulnerability
    /// cleared (so smart tiers don't refuse to swing at protected targets).
    fn sim_with(players: &[(PlayerId, [f32; 3])]) -> GameSim {
        let mut sim = GameSim::new(true);
        for &(id, pos) in players {
            sim.add_player(id, false, pos);
            let mut s = sim.snapshot(id).unwrap();
            s.state.invuln = 0;
            sim.restore(id, &s);
        }
        sim
    }

    fn place(sim: &mut GameSim, id: PlayerId, pos: [f32; 3], vel: [f32; 3]) {
        let mut s = sim.snapshot(id).unwrap();
        s.pos = pos;
        s.vel = vel;
        sim.restore(id, &s);
    }

    #[test]
    fn presets_scale_from_easy_to_expert() {
        for w in PRESETS.windows(2) {
            assert!(w[0].reaction_ticks >= w[1].reaction_ticks);
            assert!(w[0].aim_jitter >= w[1].aim_jitter);
            assert!(w[0].blunder_chance >= w[1].blunder_chance);
            assert!(w[0].light_chance <= w[1].light_chance);
            assert!(w[0].dodge_skill <= w[1].dodge_skill);
            assert!(w[0].recovery_skill <= w[1].recovery_skill);
            assert!(w[0].ledge_care <= w[1].ledge_care);
            assert!(w[0].punish_skill <= w[1].punish_skill);
        }
    }

    #[test]
    fn expert_aims_exactly_at_target() {
        let sim = sim_with(&[(0, [0.0, 1.0, 0.0]), (1, [3.0, 1.0, 4.0])]);
        let mut brain = BotBrain::new(0, BotDifficulty::Expert);
        let input = think(&sim, 0, &mut brain);
        let expect = 3.0f32.atan2(4.0);
        assert!(
            (input.yaw - expect).abs() < 1e-4,
            "expert yaw {} should be exactly {}",
            input.yaw,
            expect
        );
    }

    #[test]
    fn expert_attacks_relentlessly_easy_rarely() {
        let count = |diff: BotDifficulty| {
            let sim = sim_with(&[(0, [0.0, 1.0, 0.0]), (1, [1.2, 1.0, 0.0])]);
            let mut brain = BotBrain::new(0, diff);
            let mut presses = 0;
            for _ in 0..120 {
                if think(&sim, 0, &mut brain).buttons & buttons::LIGHT != 0 {
                    presses += 1;
                }
            }
            presses
        };
        let expert = count(BotDifficulty::Expert);
        let easy = count(BotDifficulty::Easy);
        // Press/release alternation caps presses at 60 per 120 ticks.
        assert!(
            expert >= 40,
            "expert should spam-poke in range (got {expert})"
        );
        assert!(easy < 20, "easy should rarely attack (got {easy})");
        assert!(expert > easy * 2);
    }

    #[test]
    fn expert_dodges_a_heavy_windup_medium_does_not() {
        let mut sim = sim_with(&[(0, [0.0, 1.0, 0.0]), (1, [1.0, 1.0, 0.0])]);
        let t = sim.players.get_mut(&1).unwrap();
        t.state.attack.kind = AttackKind::Heavy;
        t.state.attack.ticks = 2; // mid-windup, 16 ticks before it goes active
        let mut expert = BotBrain::new(0, BotDifficulty::Expert);
        let i = think(&sim, 0, &mut expert);
        assert_eq!(
            i.buttons,
            buttons::DASH,
            "expert i-frames through the windup"
        );
        let mut medium = BotBrain::new(0, BotDifficulty::Medium);
        let i = think(&sim, 0, &mut medium);
        assert_ne!(i.buttons, buttons::DASH, "medium can't see it coming");
    }

    #[test]
    fn expert_recovers_from_an_edge_launch_easy_falls() {
        let survives = |diff: BotDifficulty| {
            let mut sim = sim_with(&[(0, [8.0, 1.2, 0.0])]);
            let mut s = sim.snapshot(0).unwrap();
            s.vel = [11.0, 6.0, 0.0]; // blasted outward, past the rim
            s.state.launched = 35;
            sim.restore(0, &s);
            let mut brain = BotBrain::new(0, diff);
            let mut inputs = BTreeMap::new();
            for _ in 0..600 {
                inputs.insert(0, think(&sim, 0, &mut brain));
                let evs = sim.step(&inputs);
                if evs.iter().any(|e| matches!(e, SimEvent::Death { .. })) {
                    return false;
                }
            }
            true
        };
        assert!(
            survives(BotDifficulty::Expert),
            "expert should DI + double-jump + dash back to the stage"
        );
        assert!(
            !survives(BotDifficulty::Easy),
            "easy should fall to its doom"
        );
    }

    #[test]
    fn expert_detours_for_a_weapon_medium_ignores_it() {
        let build = || {
            let mut sim = sim_with(&[(0, [6.0, 1.0, 6.0]), (1, [-8.0, 1.0, -8.0])]);
            let island = *sim::arena::Arena::island_centers()
                .iter()
                .find(|c| c[0] > 0.0 && c[2] > 0.0)
                .unwrap();
            sim.spawn_pickup(0, powerup::HAMMER, [island[0], island[1] + 0.9, island[2]]);
            sim
        };
        let sim = build();
        let mut expert = BotBrain::new(0, BotDifficulty::Expert);
        let i = think(&sim, 0, &mut expert);
        assert!(
            i.move_x > 0.5 && i.move_z > 0.5,
            "expert heads for the pickup (+x,+z), got ({}, {})",
            i.move_x,
            i.move_z
        );
        let sim = build();
        let mut medium = BotBrain::new(0, BotDifficulty::Medium);
        let i = think(&sim, 0, &mut medium);
        assert!(
            i.move_x < -0.5 && i.move_z < -0.5,
            "medium ignores weapons and chases the opponent (-x,-z), got ({}, {})",
            i.move_x,
            i.move_z
        );
    }

    #[test]
    fn gun_lead_aims_ahead_of_a_strafing_target() {
        // Target due +x, strafing +z: the intercept must rotate toward +z.
        let direct = 6.0f32.atan2(0.0);
        let lead = gun_intercept(
            [0.0; 3],
            [6.0, 1.0, 0.0],
            [0.0, 0.0, 5.0],
            consts().gun_speed,
        )
        .expect("a 28 u/s bullet can intercept a 5 u/s runner");
        assert!(lead < direct, "lead {lead} should be below direct {direct}");
        assert!(
            (lead - direct).abs() > 0.05,
            "lead should be a real correction"
        );
    }

    #[test]
    fn medium_reacts_late_to_a_teleport() {
        let mut sim = sim_with(&[(0, [0.0, 1.0, 0.0]), (1, [5.0, 1.0, 0.0])]);
        let mut brain = BotBrain::new(0, BotDifficulty::Medium);
        let first = think(&sim, 0, &mut brain);
        assert!(first.move_x > 0.9, "chasing +x initially");
        place(&mut sim, 1, [-5.0, 1.0, 0.0], [0.0; 3]);
        let mut flipped_at = None;
        for i in 1..=10 {
            if think(&sim, 0, &mut brain).move_x < -0.9 {
                flipped_at = Some(i);
                break;
            }
        }
        // reaction_ticks = 6: the bot keeps chasing the stale position until
        // the next decision refresh.
        assert_eq!(flipped_at, Some(6));
    }

    #[test]
    fn expert_beats_easy_in_a_duel() {
        let spawns = [
            ([4.0, 1.2, 0.0], [-4.0, 1.2, 0.0]),
            ([2.0, 1.2, 3.0], [-3.0, 1.2, -2.0]),
            ([6.0, 1.2, 1.0], [1.0, 1.2, -5.0]),
        ];
        for (a, b) in spawns {
            let mut sim = sim_with(&[(0, a), (1, b)]);
            let mut expert = BotBrain::new(0, BotDifficulty::Expert);
            let mut easy = BotBrain::new(1, BotDifficulty::Easy);
            let mut inputs = BTreeMap::new();
            let mut dead = None;
            'sim: for _ in 0..3600 {
                inputs.insert(0, think(&sim, 0, &mut expert));
                inputs.insert(1, think(&sim, 1, &mut easy));
                for e in sim.step(&inputs) {
                    if let SimEvent::Death { player, .. } = e {
                        dead = Some(player);
                        break 'sim;
                    }
                }
            }
            assert_eq!(dead, Some(1), "expert must ring out easy from spawn {a:?}");
        }
    }

    #[test]
    fn expert_panics_before_leaving_the_platform() {
        // Airborne above solid ground, but the ballistic arc lands off-stage:
        // panic mode must already be steering inward. Hard's reactive
        // recovery hasn't fired yet — it's still over solid tiles.
        let mut sim = sim_with(&[(0, [9.0, 3.0, 0.0])]);
        place(&mut sim, 0, [9.0, 3.0, 0.0], [10.0, 0.0, 0.0]);
        let mut expert = BotBrain::new(0, BotDifficulty::Expert);
        let i = think(&sim, 0, &mut expert);
        assert!(
            i.move_x < -0.5,
            "expert should steer against the overshoot, got move_x {}",
            i.move_x
        );
        let mut hard = BotBrain::new(0, BotDifficulty::Hard);
        let i = think(&sim, 0, &mut hard);
        assert!(
            i.move_x > -0.1,
            "hard reacts only once past the edge, got move_x {}",
            i.move_x
        );
    }

    #[test]
    fn panic_dashes_across_a_big_gap_when_jumps_are_spent() {
        let mut sim = sim_with(&[(0, [14.0, 2.0, 0.0])]);
        let mut s = sim.snapshot(0).unwrap();
        s.pos = [14.0, 2.0, 0.0];
        s.vel = [0.0, -1.0, 0.0];
        s.state.jump_count = 2;
        sim.restore(0, &s);
        let mut expert = BotBrain::new(0, BotDifficulty::Expert);
        let i = think(&sim, 0, &mut expert);
        assert_eq!(i.buttons, buttons::DASH, "dash is the only boost left");
        assert!(
            i.move_x < -0.5,
            "dash must point at the deck, got {}",
            i.move_x
        );
    }

    #[test]
    fn panic_prefers_dash_even_with_jumps_left() {
        // Big gap: dash first (more distance, pauses gravity), keep the
        // jumps for after.
        let mut sim = sim_with(&[(0, [14.0, 2.0, 0.0])]);
        place(&mut sim, 0, [14.0, 2.0, 0.0], [0.0, -1.0, 0.0]);
        let mut expert = BotBrain::new(0, BotDifficulty::Expert);
        let i = think(&sim, 0, &mut expert);
        assert_eq!(i.buttons, buttons::DASH, "big gap: dash before jumping");
    }

    #[test]
    fn expert_survives_a_violent_edge_launch() {
        // Stronger than the mild scenario above: without the panic ladder
        // (dash-first + urgent below-deck jumps) this launch is lethal.
        let mut sim = sim_with(&[(0, [8.0, 1.2, 0.0])]);
        let mut s = sim.snapshot(0).unwrap();
        s.vel = [14.0, 7.0, 0.0];
        s.state.launched = 45;
        sim.restore(0, &s);
        let mut brain = BotBrain::new(0, BotDifficulty::Expert);
        let mut inputs = BTreeMap::new();
        for tick in 0..600 {
            inputs.insert(0, think(&sim, 0, &mut brain));
            let evs = sim.step(&inputs);
            assert!(
                !evs.iter().any(|e| matches!(e, SimEvent::Death { .. })),
                "expert died to a violent edge launch at tick {tick}"
            );
        }
    }

    #[test]
    fn dodge_dash_never_leaves_the_stage() {
        let mut sim = sim_with(&[(0, [1.6, 1.0, 0.0]), (1, [0.2, 1.0, 0.0])]);
        // Shrink until only rings 0-1 remain (a 3x3 platform), so every
        // perpendicular dash from the rim would fly off the stage.
        let c = consts();
        sim.arena_apply_until(
            c.shrink_start_ticks + 3 * c.shrink_ring_interval_ticks + c.tile_warning_ticks + 1,
        );
        assert!(
            on_solid(&sim, [1.6, 1.0, 0.0]),
            "bot should still be on the stage"
        );
        assert!(!on_solid(&sim, [1.6, 1.0, 3.3]), "ring 2 should be gone");
        let t = sim.players.get_mut(&1).unwrap();
        t.state.attack.kind = AttackKind::Heavy;
        t.state.attack.ticks = 2;
        let mut expert = BotBrain::new(0, BotDifficulty::Expert);
        let i = think(&sim, 0, &mut expert);
        if i.buttons == buttons::DASH {
            let dash_len = c.dash_speed * c.dash_ticks as f32 * dt();
            let end = [1.6 + i.move_x * dash_len, 1.0, i.move_z * dash_len];
            assert!(on_solid(&sim, end), "dodge dash must land on solid tiles");
        }
    }

    #[test]
    fn impossible_walks_out_of_a_baited_swing() {
        // Opponent presses light at the very edge of reach — the classic
        // dash-bait. Impossible walks out and keeps its dash; Expert burns it.
        let build = || {
            let mut sim = sim_with(&[(0, [0.0, 1.0, 0.0]), (1, [2.9, 1.0, 0.0])]);
            let t = sim.players.get_mut(&1).unwrap();
            t.state.attack.kind = AttackKind::Light;
            t.state.attack.ticks = 0;
            sim
        };
        let sim = build();
        let mut imp = BotBrain::new(0, BotDifficulty::Impossible);
        let i = think(&sim, 0, &mut imp);
        assert_eq!(
            i.buttons, 0,
            "impossible should not spend the dash on a bait"
        );
        assert!(
            i.move_x < -0.5,
            "it should be walking out, got move_x {}",
            i.move_x
        );
        let sim = build();
        let mut exp = BotBrain::new(0, BotDifficulty::Expert);
        let i = think(&sim, 0, &mut exp);
        assert_eq!(i.buttons, buttons::DASH, "expert takes the bait");
    }

    #[test]
    fn impossible_ignores_a_whiffing_bait() {
        // A swing from out of reach (would miss by ~0.25) must not move it
        // at all: no dash spent, approach continues. Expert takes the bait.
        let build = || {
            let mut sim = sim_with(&[(0, [0.0, 1.0, 0.0]), (1, [3.5, 1.0, 0.0])]);
            let t = sim.players.get_mut(&1).unwrap();
            t.state.attack.kind = AttackKind::Light;
            t.state.attack.ticks = 0;
            sim
        };
        let sim = build();
        let mut imp = BotBrain::new(0, BotDifficulty::Impossible);
        let i = think(&sim, 0, &mut imp);
        assert_eq!(i.buttons, 0, "a whiffing bait deserves no reaction");
        assert!(
            i.move_x > 0.5,
            "it should keep closing on the baiter, got move_x {}",
            i.move_x
        );
        let sim = build();
        let mut exp = BotBrain::new(0, BotDifficulty::Expert);
        let i = think(&sim, 0, &mut exp);
        assert_eq!(i.buttons, buttons::DASH, "expert still takes the bait");
    }

    #[test]
    fn impossible_chases_a_camper_onto_an_island() {
        // A target parked on an island must not be safe: the bot has to
        // cross the gap (ground jump + air jump + dash) and land a hit.
        let island = *sim::arena::Arena::island_centers()
            .iter()
            .find(|c| c[0] > 0.0 && c[2] > 0.0)
            .unwrap();
        let camper = [island[0], island[1] + 1.2, island[2]];
        let mut sim = sim_with(&[(0, [2.0, 1.2, 2.0]), (1, camper)]);
        let mut imp = BotBrain::new(0, BotDifficulty::Impossible);
        let mut inputs = BTreeMap::new();
        let mut reached = false;
        for _ in 0..900 {
            inputs.insert(0, think(&sim, 0, &mut imp));
            // The camper stands still, like a player waiting the bot out.
            inputs.insert(1, PlayerInput::default());
            for e in sim.step(&inputs) {
                match e {
                    SimEvent::Hit {
                        attacker: 0,
                        target: 1,
                        ..
                    } => reached = true,
                    SimEvent::Death { player: 0, .. } => {
                        panic!("bot died crossing to the island")
                    }
                    _ => {}
                }
            }
            if reached {
                break;
            }
        }
        assert!(reached, "the camper must get hit on their island");
    }

    #[test]
    fn impossible_dodges_bullets_on_foot() {
        // A gunner 11 units out, firing straight at us: plenty of flight
        // time, so strafe on foot, keep the dash, take zero damage.
        let mut sim = sim_with(&[(0, [0.0, 1.0, 0.0]), (1, [11.0, 1.0, 0.0])]);
        let mut s = sim.snapshot(1).unwrap();
        s.state.powerup = powerup::GUN;
        s.state.powerup_ticks = 600;
        sim.restore(1, &s);
        let mut imp = BotBrain::new(0, BotDifficulty::Impossible);
        let mut inputs = BTreeMap::new();
        let gunner_yaw = (-11.0f32).atan2(0.0); // facing the bot
        for tick in 0..60 {
            let i = think(&sim, 0, &mut imp);
            assert_ne!(
                i.buttons,
                buttons::DASH,
                "bullets should be strafed, not dashed"
            );
            inputs.insert(0, i);
            // Fire on the first tick (rising edge), then hold facing.
            inputs.insert(
                1,
                PlayerInput {
                    move_x: 0.0,
                    move_z: 0.0,
                    yaw: gunner_yaw,
                    buttons: if tick == 0 { buttons::LIGHT } else { 0 },
                },
            );
            sim.step(&inputs);
        }
        assert_eq!(
            sim.snapshot(0).unwrap().damage,
            0,
            "a strafed bullet never lands"
        );
    }

    /// Deterministic spread of duel spawn pairs: varied radii and angles.
    /// Each pair is also meant to be played with roles swapped (which swaps
    /// the slot-derived RNG seeds), giving 24 distinct duels.
    fn duel_spawns() -> Vec<([f32; 3], [f32; 3])> {
        let mut v = Vec::new();
        for i in 0..24u32 {
            let a = i as f32 * 0.2618; // 15° steps
            let r1 = 3.5 + (i % 4) as f32 * 0.8;
            let r2 = 4.0 + ((i / 4) % 4) as f32 * 0.7;
            v.push((
                [r1 * a.sin(), 1.2, r1 * a.cos()],
                [-r2 * (a + 1.1).sin(), 1.2, -r2 * (a + 1.1).cos()],
            ));
        }
        v
    }

    /// 48 duels of Impossible against `foe` (24 spawn pairs x both slot
    /// assignments); returns (impossible wins, losses, stalls).
    fn impossible_series(foe: BotDifficulty) -> (u32, u32, u32) {
        let (mut w, mut l, mut s) = (0, 0, 0);
        for (a, b) in duel_spawns() {
            match duel(BotDifficulty::Impossible, a, foe, b) {
                Some(1) => w += 1,
                Some(0) => l += 1,
                _ => s += 1,
            }
            match duel(foe, a, BotDifficulty::Impossible, b) {
                Some(0) => w += 1,
                Some(1) => l += 1,
                _ => s += 1,
            }
        }
        (w, l, s)
    }

    /// Run one shrink-forced duel to the first death; returns the loser.
    fn duel(a_diff: BotDifficulty, a: [f32; 3], b_diff: BotDifficulty, b: [f32; 3]) -> Option<u8> {
        let mut sim = sim_with(&[(0, a), (1, b)]);
        let mut ba = BotBrain::new(0, a_diff);
        let mut bb = BotBrain::new(1, b_diff);
        let mut inputs = BTreeMap::new();
        let c = consts();
        // Stop before the last tiles fall — past that both must die and the
        // order stops meaning anything.
        for tick in 0..4200u32 {
            sim.arena_apply_until(tick);
            // Weapons spawn like in a real round (deterministic island/kind
            // rotation instead of the room's RNG).
            if tick >= c.pickup_first_spawn_ticks
                && (tick - c.pickup_first_spawn_ticks) % c.pickup_spawn_interval_ticks == 0
            {
                let n = ((tick - c.pickup_first_spawn_ticks) / c.pickup_spawn_interval_ticks) as u8;
                let centers = sim::arena::Arena::island_centers();
                let island = n % centers.len() as u8;
                if !sim.pickups.iter().any(|pu| pu.id == island) {
                    let kind = powerup::HAMMER + n % 4;
                    let mut pos = centers[island as usize];
                    pos[1] += 0.9;
                    sim.spawn_pickup(island, kind, pos);
                }
            }
            inputs.insert(0, think(&sim, 0, &mut ba));
            inputs.insert(1, think(&sim, 1, &mut bb));
            for e in sim.step(&inputs) {
                if let SimEvent::Death { player, .. } = e {
                    return Some(player);
                }
            }
        }
        None
    }

    #[test]
    fn impossible_beats_hard_series() {
        // Hard is the strongest human-like opponent (near-instant reactions,
        // 50% opportunity conversion). Measured 32W-11L-5S; assert with a
        // small margin (deterministic, so this is a regression guard).
        let (w, l, s) = impossible_series(BotDifficulty::Hard);
        assert!(
            w >= 28 && l <= 15,
            "impossible should crush hard, got {w}W-{l}L-{s}S of 48"
        );
    }

    #[test]
    #[ignore]
    fn measure_impossible_vs_expert_winrate() {
        // Dev tool: `cargo test -p gameserver measure_ -- --ignored --nocapture`
        let (w, l, s) = impossible_series(BotDifficulty::Expert);
        println!("impossible vs expert over 48 duels: {w} wins, {l} losses, {s} stalls");
        let (w, l, s) = impossible_series(BotDifficulty::Hard);
        println!("impossible vs hard   over 48 duels: {w} wins, {l} losses, {s} stalls");
        let (mut w2, mut l2, mut s2) = (0, 0, 0);
        for (a, b) in duel_spawns() {
            match duel(BotDifficulty::Expert, a, BotDifficulty::Hard, b) {
                Some(1) => w2 += 1,
                Some(0) => l2 += 1,
                _ => s2 += 1,
            }
            match duel(BotDifficulty::Hard, a, BotDifficulty::Expert, b) {
                Some(0) => w2 += 1,
                Some(1) => l2 += 1,
                _ => s2 += 1,
            }
        }
        println!("expert     vs hard   over 48 duels: {w2} wins, {l2} losses, {s2} stalls");
    }

    #[test]
    fn impossible_outperforms_expert_winrate() {
        // The user-facing bar: across a deterministic 48-duel series (24
        // spawn geometries x both slot assignments, weapons spawning as in
        // real rounds, arena shrink forcing results), Impossible must beat
        // the tier below it clearly more often than it loses. Measured
        // 29W-19L-0S (60%, a +50% relative edge); assert with margin.
        // Note the ceiling: both tiers share the same frame-perfect combat
        // core, so head-to-head parity pressure is structural — Impossible's
        // edge comes from recovery, evasion, and positioning extras.
        let (w, l, s) = impossible_series(BotDifficulty::Expert);
        assert!(
            w >= 26 && w > l,
            "impossible should clearly out-duel expert, got {w}W-{l}L-{s}S of 48"
        );
    }

    #[test]
    fn think_streams_are_deterministic() {
        let run = || {
            let mut sim = sim_with(&[(0, [3.0, 1.2, 0.0]), (1, [-3.0, 1.2, 0.0])]);
            let mut b0 = BotBrain::new(0, BotDifficulty::Expert);
            let mut b1 = BotBrain::new(1, BotDifficulty::Hard);
            let mut inputs = BTreeMap::new();
            let mut trace: Vec<(u32, u8, u8)> = Vec::new();
            for _ in 0..300 {
                let i0 = think(&sim, 0, &mut b0);
                let i1 = think(&sim, 1, &mut b1);
                trace.push((i0.yaw.to_bits(), i0.buttons, i1.buttons));
                inputs.insert(0, i0);
                inputs.insert(1, i1);
                sim.step(&inputs);
            }
            trace
        };
        assert_eq!(
            run(),
            run(),
            "same seeds + same world must replay identically"
        );
    }
}
