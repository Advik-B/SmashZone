//! GameSim: the authoritative simulation. The server runs it with
//! `combat_enabled = true` over all players; the client runs a second copy in
//! WASM with combat disabled, simulating only the local player against the
//! arena plus kinematic proxies of remote players.

use crate::arena::{Arena, TileState};
use crate::character::{self, attack_phase, facing_dir, AttackPhase};
use crate::constants::{consts, dt};
use crate::types::{
    powerup, AnimState, AttackKind, CharSnapshot, CharState, PlayerId, PlayerInput, SimEvent,
};
use rapier3d::prelude::*;
use std::collections::BTreeMap;

/// Where dead bodies are parked, far below the kill plane.
const GRAVEYARD_Y: f32 = -200.0;

pub struct Player {
    pub id: PlayerId,
    pub body: RigidBodyHandle,
    pub state: CharState,
    pub damage: u16,
    pub alive: bool,
    /// Kinematic stand-in for a remote player in the client's prediction world.
    pub proxy: bool,
}

/// Weapon pickup floating on an island. Pure data — collection is a distance
/// check, no physics body involved.
pub struct Pickup {
    pub id: u8,
    pub kind: u8,
    pub pos: [f32; 3],
}

/// Server-simulated projectile (gun bullet or thrown bomb). Manually
/// integrated; never exists in client prediction worlds.
pub struct Projectile {
    pub id: u16,
    pub kind: u8,
    pub owner: PlayerId,
    pub pos: Vector<f32>,
    pub vel: Vector<f32>,
    pub ttl: u16,
}

pub struct GameSim {
    pipeline: PhysicsPipeline,
    islands: IslandManager,
    broad_phase: DefaultBroadPhase,
    narrow_phase: NarrowPhase,
    pub bodies: RigidBodySet,
    pub colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd: CCDSolver,
    query_pipeline: QueryPipeline,
    params: IntegrationParameters,
    gravity: Vector<f32>,
    // BTreeMap: deterministic iteration order matters for reproducibility.
    pub players: BTreeMap<PlayerId, Player>,
    pub arena: Arena,
    pub combat_enabled: bool,
    pub pickups: Vec<Pickup>,
    pub projectiles: Vec<Projectile>,
    next_proj_id: u16,
}

impl GameSim {
    pub fn new(combat_enabled: bool) -> GameSim {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let arena = Arena::new(&mut bodies, &mut colliders);
        let mut params = IntegrationParameters::default();
        params.dt = dt();
        let mut sim = GameSim {
            pipeline: PhysicsPipeline::new(),
            islands: IslandManager::new(),
            broad_phase: DefaultBroadPhase::new(),
            narrow_phase: NarrowPhase::new(),
            bodies,
            colliders,
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd: CCDSolver::new(),
            query_pipeline: QueryPipeline::new(),
            params,
            gravity: vector![0.0, consts().gravity, 0.0],
            players: BTreeMap::new(),
            arena,
            combat_enabled,
            pickups: Vec::new(),
            projectiles: Vec::new(),
            next_proj_id: 0,
        };
        sim.query_pipeline.update(&sim.colliders);
        sim
    }

    pub fn add_player(&mut self, id: PlayerId, proxy: bool, pos: [f32; 3]) {
        let c = consts();
        let builder = if proxy {
            RigidBodyBuilder::kinematic_position_based()
        } else {
            RigidBodyBuilder::dynamic().lock_rotations().ccd_enabled(true)
        };
        let body = self.bodies.insert(
            builder
                .translation(vector![pos[0], pos[1], pos[2]])
                .linear_damping(0.0),
        );
        self.colliders.insert_with_parent(
            ColliderBuilder::capsule_y(c.player_half_height, c.player_radius)
                .friction(0.0)
                .density(0.0)
                .mass(c.player_mass)
                .user_data(id as u128 + 1),
            body,
            &mut self.bodies,
        );
        self.players.insert(
            id,
            Player {
                id,
                body,
                state: CharState::default(),
                damage: 0,
                alive: true,
                proxy,
            },
        );
    }

    pub fn remove_player(&mut self, id: PlayerId) {
        if let Some(p) = self.players.remove(&id) {
            self.bodies.remove(
                p.body,
                &mut self.islands,
                &mut self.colliders,
                &mut self.impulse_joints,
                &mut self.multibody_joints,
                true,
            );
        }
    }

    pub fn respawn(&mut self, id: PlayerId, pos: [f32; 3]) {
        if let Some(p) = self.players.get_mut(&id) {
            let body = &mut self.bodies[p.body];
            body.set_body_type(RigidBodyType::Dynamic, true);
            body.set_translation(vector![pos[0], pos[1], pos[2]], true);
            body.set_linvel(vector![0.0, 0.0, 0.0], true);
            p.state = CharState::default();
            p.damage = 0;
            p.alive = true;
        }
    }

    /// Mark a player dead and park the body (spectators, mid-match joiners).
    pub fn kill(&mut self, id: PlayerId) {
        if let Some(p) = self.players.get_mut(&id) {
            if p.alive {
                Self::park(&mut self.bodies, p);
            }
        }
    }

    /// Park a dead player's body out of the way.
    fn park(bodies: &mut RigidBodySet, p: &mut Player) {
        p.alive = false;
        let body = &mut bodies[p.body];
        body.set_body_type(RigidBodyType::Fixed, true);
        body.set_translation(vector![p.id as f32 * 5.0, GRAVEYARD_Y, 0.0], true);
        body.set_linvel(vector![0.0, 0.0, 0.0], true);
    }

    pub fn set_proxy_state(&mut self, id: PlayerId, pos: [f32; 3], yaw: f32) {
        if let Some(p) = self.players.get_mut(&id) {
            p.state.facing = yaw;
            self.bodies[p.body].set_next_kinematic_translation(vector![pos[0], pos[1], pos[2]].into());
        }
    }

    pub fn arena_apply_until(&mut self, round_tick: u32) -> Vec<SimEvent> {
        let events = self.arena.apply_until(
            round_tick,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.islands,
        );
        if !events.is_empty() {
            self.query_pipeline.update(&self.colliders);
        }
        events
    }

    pub fn arena_reset(&mut self) {
        self.arena.reset(&mut self.bodies, &mut self.colliders);
        self.query_pipeline.update(&self.colliders);
    }

    /// New-round housekeeping beyond the arena: no leftover weapons.
    pub fn reset_round(&mut self) {
        self.pickups.clear();
        self.projectiles.clear();
    }

    /// Register a pickup (id doubles as the island index for occupancy checks)
    /// and return the event to broadcast.
    pub fn spawn_pickup(&mut self, id: u8, kind: u8, pos: [f32; 3]) -> SimEvent {
        self.pickups.push(Pickup { id, kind, pos });
        SimEvent::PickupSpawn { id, kind, pos }
    }

    fn grounded(&self, p: &Player) -> bool {
        let c = consts();
        let pos = self.bodies[p.body].translation();
        let ray = Ray::new(point![pos.x, pos.y, pos.z], vector![0.0, -1.0, 0.0]);
        let max_toi = c.player_half_height + c.player_radius + 0.12;
        let filter = QueryFilter::default().exclude_rigid_body(p.body);
        self.query_pipeline
            .cast_ray(&self.bodies, &self.colliders, &ray, max_toi, true, filter)
            .is_some()
    }

    /// Apply one hit to a target: powerup modifiers (attacker hammer, target
    /// anchor), launch-meter scaling, impulse, launched state, event.
    /// `dir` need not be normalized; it should already include any up-bias.
    fn apply_hit(
        &mut self,
        attacker: PlayerId,
        target: PlayerId,
        mut dir: Vector<f32>,
        base_impulse: f32,
        base_damage: u16,
        heavy: bool,
        events: &mut Vec<SimEvent>,
    ) {
        let c = consts();
        let attacker_pu = self
            .players
            .get(&attacker)
            .map(|p| p.state.powerup)
            .unwrap_or(powerup::NONE);
        let Some(t) = self.players.get(&target) else {
            return;
        };
        if !t.alive || t.proxy {
            return;
        }
        let mut imp_mult = 1.0f32;
        let mut dmg_mult = 1.0f32;
        if attacker_pu == powerup::HAMMER {
            imp_mult *= c.hammer_mult;
            dmg_mult *= c.hammer_mult;
        }
        if t.state.powerup == powerup::ANCHOR {
            imp_mult *= c.anchor_mult;
        }
        let damage = (base_damage as f32 * dmg_mult).round() as u16;
        let scale =
            (1.0 + (t.damage + damage) as f32 * c.launch_scale_per_damage) * imp_mult;
        if dir.norm() < 0.01 {
            dir = vector![0.0, 1.0, 0.0];
        }
        dir = dir.normalize();
        let impulse = dir * base_impulse * scale;
        let launch = (c.launched_min_ticks as f32 * scale).min(600.0) as u16;

        let t = self.players.get_mut(&target).unwrap();
        t.damage = t.damage.saturating_add(damage);
        t.state.launched = t.state.launched.max(launch);
        t.state.slamming = false;
        t.state.dash_ticks = 0;
        self.bodies[t.body].apply_impulse(impulse * c.player_mass, true);
        events.push(SimEvent::Hit {
            attacker,
            target,
            dir: [impulse.x, impulse.y, impulse.z],
            heavy,
            damage,
        });
    }

    /// Advance the world one tick. `inputs` holds intents for simulated
    /// (non-proxy) players; missing entries mean "neutral stick, no buttons"
    /// but button state is remembered so releases register.
    pub fn step(&mut self, inputs: &BTreeMap<PlayerId, PlayerInput>) -> Vec<SimEvent> {
        let c = consts();
        let mut events = Vec::new();

        // 1. Ground checks (previous-step query state).
        let ids: Vec<PlayerId> = self.players.keys().copied().collect();
        for &id in &ids {
            let p = &self.players[&id];
            if p.proxy || !p.alive {
                continue;
            }
            let g = self.grounded(p);
            self.players.get_mut(&id).unwrap().state.grounded = g;
        }

        // 2. Movement.
        for &id in &ids {
            let p = self.players.get_mut(&id).unwrap();
            if p.proxy || !p.alive {
                continue;
            }
            let neutral = PlayerInput {
                yaw: p.state.facing,
                ..Default::default()
            };
            let input = inputs.get(&id).copied().unwrap_or(neutral);
            character::tick_movement(&mut self.bodies[p.body], &mut p.state, &input);
        }

        // 2.5 Consume fire intents. Cleared in every world (so prediction and
        // server stay in lockstep); projectiles only spawn on the server.
        for &id in &ids {
            let Some(p) = self.players.get_mut(&id) else {
                continue;
            };
            if !p.state.fire_intent {
                continue;
            }
            p.state.fire_intent = false;
            if p.proxy || !p.alive {
                continue;
            }
            let kind = p.state.powerup;
            let facing = p.state.facing;
            let body = p.body;
            if !self.combat_enabled || (kind != powerup::GUN && kind != powerup::BOMB) {
                continue;
            }
            let pos = *self.bodies[body].translation();
            let fwd = facing_dir(facing);
            self.next_proj_id = self.next_proj_id.wrapping_add(1);
            let (vel, ttl, offset) = if kind == powerup::GUN {
                (
                    fwd * c.gun_speed,
                    c.gun_ttl_ticks,
                    fwd * 0.8 + vector![0.0, 0.4, 0.0],
                )
            } else {
                (
                    fwd * c.bomb_throw_speed + vector![0.0, c.bomb_throw_up, 0.0],
                    c.bomb_fuse_ticks,
                    fwd * 0.8 + vector![0.0, 0.6, 0.0],
                )
            };
            self.projectiles.push(Projectile {
                id: self.next_proj_id,
                kind,
                owner: id,
                pos: pos + offset,
                vel,
                ttl,
            });
            events.push(SimEvent::Fired { player: id, kind });
        }

        // 3. Melee combat: collect hits immutably, then apply.
        if self.combat_enabled {
            struct PendingHit {
                attacker: PlayerId,
                target: PlayerId,
                dir: Vector<f32>,
                impulse: f32,
                damage: u16,
                heavy: bool,
            }
            let mut pending: Vec<PendingHit> = Vec::new();
            let mut slam_landed: Vec<PlayerId> = Vec::new();

            for (&id, p) in &self.players {
                if p.proxy || !p.alive {
                    continue;
                }
                let my_pos = *self.bodies[p.body].translation();

                // Melee swings during the active window.
                if attack_phase(&p.state) == AttackPhase::Active {
                    let heavy = p.state.attack.kind == AttackKind::Heavy;
                    let (reach, radius, impulse, damage) = if heavy {
                        (c.heavy_reach, c.heavy_hit_radius, c.heavy_impulse, c.heavy_damage)
                    } else {
                        (c.light_reach, c.light_hit_radius, c.light_impulse, c.light_damage)
                    };
                    let fwd = facing_dir(p.state.facing);
                    let origin = my_pos + fwd * reach;
                    let shape = Ball::new(radius);
                    let shape_pos = Isometry::translation(origin.x, origin.y, origin.z);
                    let filter = QueryFilter::default().exclude_rigid_body(p.body);
                    let mut targets: Vec<PlayerId> = Vec::new();
                    self.query_pipeline.intersections_with_shape(
                        &self.bodies,
                        &self.colliders,
                        &shape_pos,
                        &shape,
                        filter,
                        |handle| {
                            let ud = self.colliders[handle].user_data;
                            if ud > 0 {
                                targets.push((ud - 1) as PlayerId);
                            }
                            true
                        },
                    );
                    for tid in targets {
                        if tid == id || p.state.attack.hit_mask & (1 << tid) != 0 {
                            continue;
                        }
                        let Some(t) = self.players.get(&tid) else { continue };
                        if !t.alive || t.proxy {
                            continue;
                        }
                        let t_pos = self.bodies[t.body].translation();
                        let mut dir = vector![t_pos.x - my_pos.x, 0.0, t_pos.z - my_pos.z];
                        if dir.norm() < 0.01 {
                            dir = fwd;
                        }
                        dir = dir.normalize();
                        dir.y = c.hit_upward_bias;
                        pending.push(PendingHit {
                            attacker: id,
                            target: tid,
                            dir,
                            impulse,
                            damage,
                            heavy,
                        });
                    }
                }

                // Slam AoE on landing.
                if p.state.slamming && p.state.grounded {
                    slam_landed.push(id);
                    let shape = Ball::new(c.slam_radius);
                    let shape_pos = Isometry::translation(my_pos.x, my_pos.y, my_pos.z);
                    let filter = QueryFilter::default().exclude_rigid_body(p.body);
                    let mut targets: Vec<PlayerId> = Vec::new();
                    self.query_pipeline.intersections_with_shape(
                        &self.bodies,
                        &self.colliders,
                        &shape_pos,
                        &shape,
                        filter,
                        |handle| {
                            let ud = self.colliders[handle].user_data;
                            if ud > 0 {
                                targets.push((ud - 1) as PlayerId);
                            }
                            true
                        },
                    );
                    for tid in targets {
                        if tid == id {
                            continue;
                        }
                        let Some(t) = self.players.get(&tid) else { continue };
                        if !t.alive || t.proxy {
                            continue;
                        }
                        let t_pos = self.bodies[t.body].translation();
                        let mut dir = vector![t_pos.x - my_pos.x, 0.0, t_pos.z - my_pos.z];
                        if dir.norm() < 0.01 {
                            dir = vector![0.0, 1.0, 0.0];
                        } else {
                            dir = dir.normalize();
                        }
                        dir.y = 1.2; // slams knock UP
                        pending.push(PendingHit {
                            attacker: id,
                            target: tid,
                            dir,
                            impulse: c.slam_impulse,
                            damage: c.slam_damage,
                            heavy: true,
                        });
                    }
                }
            }

            for id in slam_landed {
                let p = self.players.get_mut(&id).unwrap();
                p.state.slamming = false;
                let pos = self.bodies[p.body].translation();
                events.push(SimEvent::Slam {
                    player: id,
                    pos: [pos.x, pos.y, pos.z],
                });
            }

            for hit in pending {
                if let Some(a) = self.players.get_mut(&hit.attacker) {
                    a.state.attack.hit_mask |= 1 << hit.target;
                }
                self.apply_hit(
                    hit.attacker,
                    hit.target,
                    hit.dir,
                    hit.impulse,
                    hit.damage,
                    hit.heavy,
                    &mut events,
                );
            }
        }

        // 4. Physics step.
        self.pipeline.step(
            &self.gravity,
            &self.params,
            &mut self.islands,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd,
            Some(&mut self.query_pipeline),
            &(),
            &(),
        );

        // 4.5 Projectiles: integrate, segment-cast for contacts, explode.
        if self.combat_enabled && !self.projectiles.is_empty() {
            let dtv = dt();
            // (attacker, target, dir-with-bias, base impulse, base damage)
            let mut hits: Vec<(PlayerId, PlayerId, Vector<f32>, f32, u16)> = Vec::new();
            let mut explosions: Vec<(Vector<f32>, PlayerId)> = Vec::new();

            let mut survivors = Vec::with_capacity(self.projectiles.len());
            for mut pr in std::mem::take(&mut self.projectiles) {
                if pr.kind == powerup::BOMB {
                    pr.vel.y += c.gravity * dtv;
                }
                let start = pr.pos;
                let delta = pr.vel * dtv;
                let dist = delta.norm();
                let mut dead = false;

                if dist > 1e-6 {
                    let dir = delta / dist;
                    let ray = Ray::new(point![start.x, start.y, start.z], dir);
                    let mut filter = QueryFilter::default();
                    if let Some(owner) = self.players.get(&pr.owner) {
                        filter = filter.exclude_rigid_body(owner.body);
                    }
                    if let Some((handle, toi)) = self.query_pipeline.cast_ray(
                        &self.bodies,
                        &self.colliders,
                        &ray,
                        dist,
                        true,
                        filter,
                    ) {
                        let contact = start + dir * toi;
                        let ud = self.colliders[handle].user_data;
                        if pr.kind == powerup::GUN {
                            if ud > 0 {
                                let target = (ud - 1) as PlayerId;
                                let mut hdir = vector![pr.vel.x, 0.0, pr.vel.z];
                                if hdir.norm() < 0.01 {
                                    hdir = vector![0.0, 0.0, 1.0];
                                } else {
                                    hdir = hdir.normalize();
                                }
                                hdir.y = c.hit_upward_bias * 0.7;
                                hits.push((pr.owner, target, hdir, c.gun_impulse, c.gun_damage));
                            }
                            // Small impact puff wherever the bullet stopped.
                            events.push(SimEvent::Explosion {
                                pos: [contact.x, contact.y, contact.z],
                                kind: powerup::GUN,
                            });
                            dead = true;
                        } else {
                            explosions.push((contact, pr.owner));
                            dead = true;
                        }
                    }
                }

                if !dead {
                    pr.pos += delta;
                    pr.ttl = pr.ttl.saturating_sub(1);
                    if pr.ttl == 0 {
                        if pr.kind == powerup::BOMB {
                            explosions.push((pr.pos, pr.owner));
                        }
                        dead = true;
                    } else if pr.pos.y < c.kill_plane_y {
                        dead = true;
                    }
                }
                if !dead {
                    survivors.push(pr);
                }
            }
            self.projectiles = survivors;

            for (pos, owner) in explosions {
                events.push(SimEvent::Explosion {
                    pos: [pos.x, pos.y, pos.z],
                    kind: powerup::BOMB,
                });
                // AoE over players; the thrower is NOT exempt.
                let targets: Vec<(PlayerId, Vector<f32>)> = self
                    .players
                    .iter()
                    .filter(|(_, t)| t.alive && !t.proxy)
                    .filter_map(|(&tid, t)| {
                        let tp = self.bodies[t.body].translation();
                        let d = vector![tp.x - pos.x, tp.y - pos.y, tp.z - pos.z];
                        (d.norm() <= c.bomb_radius).then_some((tid, d))
                    })
                    .collect();
                for (tid, d) in targets {
                    let mut dir = vector![d.x, 0.0, d.z];
                    if dir.norm() >= 0.01 {
                        dir = dir.normalize();
                    }
                    dir.y = 0.8; // bombs pop players UP
                    hits.push((owner, tid, dir, c.bomb_impulse, c.bomb_damage));
                }
            }

            for (att, tgt, dir, imp, dmg) in hits {
                self.apply_hit(att, tgt, dir, imp, dmg, true, &mut events);
            }
        }

        // 4.6 Pickups: distance-based collection (replaces current powerup).
        if self.combat_enabled && !self.pickups.is_empty() {
            let mut taken: Vec<(usize, PlayerId)> = Vec::new();
            'pickups: for (i, pk) in self.pickups.iter().enumerate() {
                for (&pid, pl) in &self.players {
                    if pl.proxy || !pl.alive {
                        continue;
                    }
                    let pp = self.bodies[pl.body].translation();
                    let d = vector![
                        pp.x - pk.pos[0],
                        pp.y - pk.pos[1],
                        pp.z - pk.pos[2]
                    ];
                    if d.norm() <= c.pickup_radius {
                        taken.push((i, pid));
                        continue 'pickups;
                    }
                }
            }
            for (i, pid) in taken.into_iter().rev() {
                let pk = self.pickups.remove(i);
                let pl = self.players.get_mut(&pid).unwrap();
                pl.state.powerup = pk.kind;
                pl.state.powerup_ticks = c.powerup_duration_ticks;
                pl.state.fire_cd = 0;
                events.push(SimEvent::PickupTaken {
                    id: pk.id,
                    player: pid,
                    kind: pk.kind,
                });
            }
        }

        // 5. Kill plane.
        if self.combat_enabled {
            for &id in &ids {
                let p = self.players.get_mut(&id).unwrap();
                if p.proxy || !p.alive {
                    continue;
                }
                let pos = *self.bodies[p.body].translation();
                if pos.y < c.kill_plane_y {
                    let vel = *self.bodies[p.body].linvel();
                    events.push(SimEvent::Death {
                        player: id,
                        pos: [pos.x, pos.y, pos.z],
                        vel: [vel.x, vel.y, vel.z],
                    });
                    Self::park(&mut self.bodies, p);
                }
            }
        }

        events
    }

    // ---- State access ----

    pub fn snapshot(&self, id: PlayerId) -> Option<CharSnapshot> {
        let p = self.players.get(&id)?;
        let body = &self.bodies[p.body];
        let pos = body.translation();
        let vel = body.linvel();
        Some(CharSnapshot {
            pos: [pos.x, pos.y, pos.z],
            vel: [vel.x, vel.y, vel.z],
            state: p.state,
            damage: p.damage,
            alive: p.alive,
        })
    }

    pub fn restore(&mut self, id: PlayerId, snap: &CharSnapshot) {
        if let Some(p) = self.players.get_mut(&id) {
            let body = &mut self.bodies[p.body];
            if snap.alive && !p.alive {
                body.set_body_type(RigidBodyType::Dynamic, true);
            }
            if !snap.alive && p.alive {
                body.set_body_type(RigidBodyType::Fixed, true);
            }
            body.set_translation(vector![snap.pos[0], snap.pos[1], snap.pos[2]], true);
            body.set_linvel(vector![snap.vel[0], snap.vel[1], snap.vel[2]], true);
            p.state = snap.state;
            p.damage = snap.damage;
            p.alive = snap.alive;
        }
    }

    pub fn anim_state(&self, id: PlayerId) -> AnimState {
        let Some(p) = self.players.get(&id) else {
            return AnimState::Idle;
        };
        let st = &p.state;
        if !p.alive {
            return AnimState::Dead;
        }
        if st.launched > 0 {
            return AnimState::Launched;
        }
        if st.slamming {
            return AnimState::Slam;
        }
        if st.dash_ticks > 0 {
            return AnimState::Dash;
        }
        match (st.attack.kind, attack_phase(st)) {
            (AttackKind::Light, AttackPhase::Windup) => return AnimState::WindupLight,
            (AttackKind::Light, _) => return AnimState::SwingLight,
            (AttackKind::Heavy, AttackPhase::Windup) => return AnimState::WindupHeavy,
            (AttackKind::Heavy, _) => return AnimState::SwingHeavy,
            _ => {}
        }
        if !st.grounded {
            return AnimState::Air;
        }
        let v = self.bodies[p.body].linvel();
        if vector![v.x, 0.0, v.z].norm() > 0.8 {
            AnimState::Run
        } else {
            AnimState::Idle
        }
    }

    pub fn tile_states(&self) -> Vec<u8> {
        self.arena
            .tiles
            .iter()
            .map(|t| match t.state {
                TileState::Solid => 0u8,
                TileState::Warning => 1,
                TileState::Gone => 2,
            })
            .collect()
    }

    pub fn tile_centers(&self) -> Vec<f32> {
        self.arena
            .tiles
            .iter()
            .flat_map(|t| t.center())
            .collect()
    }

    /// Evenly spaced spawn points on a circle.
    pub fn spawn_positions(n: usize) -> Vec<[f32; 3]> {
        let c = consts();
        let r = (c.arena_half_tiles as f32 - 1.0) * c.arena_tile_size * 0.8;
        (0..n)
            .map(|i| {
                let a = i as f32 / n.max(1) as f32 * std::f32::consts::TAU;
                (a, r)
            })
            .map(|(a, r)| {
                [
                    a.sin() * r,
                    c.player_half_height + c.player_radius + 0.05,
                    a.cos() * r,
                ]
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::buttons;

    fn input(mx: f32, mz: f32, btn: u8) -> PlayerInput {
        PlayerInput {
            move_x: mx,
            move_z: mz,
            yaw: 0.0,
            buttons: btn,
        }
    }

    #[test]
    fn player_stands_on_arena() {
        let mut sim = GameSim::new(true);
        sim.add_player(0, false, [0.0, 1.05, 0.0]);
        for _ in 0..120 {
            sim.step(&BTreeMap::new());
        }
        let s = sim.snapshot(0).unwrap();
        assert!(s.alive, "player should not fall through the arena");
        assert!(s.pos[1] > 0.5 && s.pos[1] < 1.5, "y = {}", s.pos[1]);
    }

    #[test]
    fn movement_is_deterministic() {
        let run = || {
            let mut sim = GameSim::new(true);
            sim.add_player(0, false, [0.0, 1.05, 0.0]);
            let mut inputs = BTreeMap::new();
            for t in 0..300u32 {
                let btn = if t % 60 == 0 { buttons::JUMP } else { 0 };
                inputs.insert(0, input(0.7, 0.3, btn));
                sim.step(&inputs);
            }
            sim.snapshot(0).unwrap()
        };
        let a = run();
        let b = run();
        assert_eq!(a.pos, b.pos);
        assert_eq!(a.vel, b.vel);
    }

    #[test]
    fn walks_off_edge_and_dies() {
        let mut sim = GameSim::new(true);
        sim.add_player(0, false, [0.0, 1.05, 0.0]);
        let mut inputs = BTreeMap::new();
        let mut died = false;
        for _ in 0..1200 {
            // Diagonal walk: avoids landing on a sub-island on the axes.
            inputs.insert(0, input(1.0, 0.15, 0));
            for ev in sim.step(&inputs) {
                if matches!(ev, SimEvent::Death { player: 0, .. }) {
                    died = true;
                }
            }
            if died {
                break;
            }
        }
        assert!(died, "running in one direction should end below kill plane");
    }

    #[test]
    fn light_attack_knocks_target_back() {
        let mut sim = GameSim::new(true);
        sim.add_player(0, false, [0.0, 1.05, 0.0]);
        sim.add_player(1, false, [0.0, 1.05, 1.6]); // in front (facing +Z at yaw 0)
        let mut inputs = BTreeMap::new();
        // Let both settle.
        for _ in 0..30 {
            sim.step(&BTreeMap::new());
        }
        inputs.insert(0, input(0.0, 0.0, buttons::LIGHT));
        let mut hit = false;
        for t in 0..40 {
            let evs = sim.step(&inputs);
            if t == 0 {
                inputs.insert(0, input(0.0, 0.0, 0));
            }
            if evs
                .iter()
                .any(|e| matches!(e, SimEvent::Hit { target: 1, .. }))
            {
                hit = true;
                break;
            }
        }
        assert!(hit, "light attack should connect");
        let s = sim.snapshot(1).unwrap();
        assert!(s.vel[2] > 1.0, "target should fly away in +Z, vz = {}", s.vel[2]);
        assert!(s.damage > 0);
        assert!(s.state.launched > 0);
    }

    #[test]
    fn arena_shrinks_over_time() {
        let c = consts();
        let mut sim = GameSim::new(true);
        let evs = sim.arena_apply_until(c.shrink_start_ticks + c.tile_warning_ticks + 1);
        assert!(
            evs.iter().any(|e| matches!(e, SimEvent::TileFall { .. })),
            "outer ring should have fallen"
        );
        let states = sim.tile_states();
        assert!(states.iter().any(|&s| s == 2));
        assert!(states.iter().any(|&s| s == 0), "center should still be solid");
        sim.arena_reset();
        assert!(sim.tile_states().iter().all(|&s| s == 0));
    }
}

#[cfg(test)]
mod shrink_repro {
    use super::*;

    #[test]
    fn players_inside_survive_outer_ring_fall() {
        let mut sim = GameSim::new(true);
        let spawns = GameSim::spawn_positions(2);
        sim.add_player(0, false, spawns[0]);
        sim.add_player(1, false, spawns[1]);
        let inputs = BTreeMap::new();
        let mut deaths = Vec::new();
        for t in 0..(60 * 30) {
            sim.arena_apply_until(t);
            for ev in sim.step(&inputs) {
                if let SimEvent::Death { player, pos, .. } = ev {
                    deaths.push((t, player, pos));
                }
            }
        }
        assert!(deaths.is_empty(), "unexpected deaths: {deaths:?}");
    }
}

#[cfg(test)]
mod shrink_history_repro {
    use super::*;
    use crate::types::buttons;

    /// Replays the live room's exact pattern: a knockout round, the pause,
    /// arena reset + respawns, countdown, then a long stand-still round.
    #[test]
    fn round_after_knockout_history() {
        let pi = std::f32::consts::PI;
        let mut sim = GameSim::new(true);
        let spawns = GameSim::spawn_positions(2);
        sim.add_player(0, false, spawns[0]);
        sim.add_player(1, false, spawns[1]);

        // Round A: player 0 charges player 1 and mashes light attack.
        let mut inputs = BTreeMap::new();
        let mut p1_died = false;
        for t in 0..900u32 {
            sim.arena_apply_until(t);
            let mash = if t > 60 && t % 4 < 2 { buttons::LIGHT } else { 0 };
            inputs.insert(
                0,
                PlayerInput { move_x: 0.0, move_z: -1.0, yaw: pi, buttons: mash },
            );
            inputs.insert(1, PlayerInput::default());
            let evs = sim.step(&inputs);
            if evs.iter().any(|e| matches!(e, SimEvent::Death { player: 1, .. })) {
                p1_died = true;
                break;
            }
        }
        assert!(p1_died, "player 1 should get knocked out in round A");

        // Round-end pause: no arena updates, no inputs (room passes none).
        for _ in 0..240 {
            sim.step(&BTreeMap::new());
        }

        // New round: reset arena, respawn everyone, frozen countdown.
        sim.arena_reset();
        sim.respawn(0, spawns[0]);
        sim.respawn(1, spawns[1]);
        for _ in 0..180 {
            sim.step(&BTreeMap::new());
        }

        // Round B: both stand still for 30 in-game seconds.
        let mut deaths = Vec::new();
        for t in 0..(60 * 30) {
            sim.arena_apply_until(t);
            for ev in sim.step(&BTreeMap::new()) {
                if let SimEvent::Death { player, pos, .. } = ev {
                    deaths.push((t, player, pos));
                }
            }
        }
        assert!(deaths.is_empty(), "deaths in round B: {deaths:?}");
    }
}

#[cfg(test)]
mod weapons_tests {
    use super::*;
    use crate::types::buttons;

    fn settle(sim: &mut GameSim, n: u32) {
        for _ in 0..n {
            sim.step(&BTreeMap::new());
        }
    }

    fn give(sim: &mut GameSim, id: PlayerId, kind: u8) {
        let p = sim.players.get_mut(&id).unwrap();
        p.state.powerup = kind;
        p.state.powerup_ticks = 600;
    }

    #[test]
    fn islands_exist_and_fall_after_center() {
        let c = consts();
        let mut sim = GameSim::new(true);
        let n_island = sim.arena.tiles.iter().filter(|t| t.island).count();
        assert_eq!(
            n_island,
            (c.island_tiles_per_side * c.island_tiles_per_side * 4) as usize
        );

        // Just after the center tile falls, islands still stand.
        let center_fall = c.shrink_start_ticks
            + c.arena_half_tiles as u32 * c.shrink_ring_interval_ticks
            + c.tile_warning_ticks
            + 1;
        sim.arena_apply_until(center_fall);
        assert!(
            sim.arena
                .tiles
                .iter()
                .filter(|t| !t.island)
                .all(|t| t.state == TileState::Gone),
            "main platform should be fully gone"
        );
        assert!(
            sim.arena
                .tiles
                .iter()
                .filter(|t| t.island)
                .all(|t| t.state != TileState::Gone),
            "islands should outlast the center"
        );

        // One ring interval later the islands are gone too.
        sim.arena_apply_until(center_fall + c.shrink_ring_interval_ticks + c.tile_warning_ticks);
        assert!(sim.arena.tiles.iter().all(|t| t.state == TileState::Gone));
    }

    #[test]
    fn player_can_stand_on_island() {
        let mut sim = GameSim::new(true);
        let c0 = Arena::island_centers()[0];
        sim.add_player(0, false, [c0[0], 1.05, c0[2]]);
        settle(&mut sim, 60);
        let s = sim.snapshot(0).unwrap();
        assert!(s.alive && s.pos[1] > 0.5, "should stand on island, y = {}", s.pos[1]);
    }

    #[test]
    fn pickup_grants_powerup_and_despawns() {
        let mut sim = GameSim::new(true);
        sim.add_player(0, false, [0.0, 1.05, 0.0]);
        settle(&mut sim, 10);
        sim.spawn_pickup(0, powerup::HAMMER, [0.0, 1.0, 0.0]);
        let mut taken = false;
        for _ in 0..10 {
            for ev in sim.step(&BTreeMap::new()) {
                if matches!(ev, SimEvent::PickupTaken { player: 0, .. }) {
                    taken = true;
                }
            }
        }
        assert!(taken, "standing on a pickup should collect it");
        assert!(sim.pickups.is_empty());
        let s = sim.snapshot(0).unwrap();
        assert_eq!(s.state.powerup, powerup::HAMMER);
        assert!(s.state.powerup_ticks > 0);
    }

    #[test]
    fn hammer_hits_harder_and_anchor_resists() {
        let measure = |attacker_pu: u8, target_pu: u8| -> f32 {
            let mut sim = GameSim::new(true);
            sim.add_player(0, false, [0.0, 1.05, 0.0]);
            sim.add_player(1, false, [0.0, 1.05, 1.6]);
            settle(&mut sim, 30);
            if attacker_pu != powerup::NONE {
                give(&mut sim, 0, attacker_pu);
            }
            if target_pu != powerup::NONE {
                give(&mut sim, 1, target_pu);
            }
            let mut inputs = BTreeMap::new();
            inputs.insert(0, PlayerInput { yaw: 0.0, buttons: buttons::LIGHT, ..Default::default() });
            for t in 0..30 {
                let evs = sim.step(&inputs);
                if t == 0 {
                    inputs.insert(0, PlayerInput::default());
                }
                if evs.iter().any(|e| matches!(e, SimEvent::Hit { target: 1, .. })) {
                    let s = sim.snapshot(1).unwrap();
                    return vector![s.vel[0], s.vel[1], s.vel[2]].norm();
                }
            }
            panic!("no hit landed");
        };
        let base = measure(powerup::NONE, powerup::NONE);
        let hammer = measure(powerup::HAMMER, powerup::NONE);
        let anchored = measure(powerup::NONE, powerup::ANCHOR);
        assert!(hammer > base * 1.8, "hammer {hammer} vs base {base}");
        assert!(anchored < base * 0.6, "anchor {anchored} vs base {base}");
    }

    #[test]
    fn gun_fires_projectile_that_knocks_back() {
        let mut sim = GameSim::new(true);
        sim.add_player(0, false, [0.0, 1.05, 0.0]);
        sim.add_player(1, false, [0.0, 1.05, 6.0]); // downrange at +Z
        settle(&mut sim, 30);
        give(&mut sim, 0, powerup::GUN);
        let mut inputs = BTreeMap::new();
        inputs.insert(0, PlayerInput { yaw: 0.0, buttons: buttons::LIGHT, ..Default::default() });
        let mut fired = false;
        let mut hit = false;
        for t in 0..40 {
            let evs = sim.step(&inputs);
            if t == 0 {
                inputs.insert(0, PlayerInput::default());
            }
            for ev in evs {
                if matches!(ev, SimEvent::Fired { player: 0, .. }) {
                    fired = true;
                }
                if matches!(ev, SimEvent::Hit { target: 1, .. }) {
                    hit = true;
                }
            }
            if hit {
                break;
            }
        }
        assert!(fired, "gun should fire");
        assert!(hit, "bullet should hit the downrange target");
        let s = sim.snapshot(1).unwrap();
        assert!(s.vel[2] > 0.5, "target knocked in +Z, vz = {}", s.vel[2]);
        assert!(s.damage > 0);
    }

    #[test]
    fn bomb_explodes_with_aoe() {
        let mut sim = GameSim::new(true);
        sim.add_player(0, false, [0.0, 1.05, 0.0]);
        sim.add_player(1, false, [0.0, 1.05, 8.0]); // near the bomb's landing arc
        settle(&mut sim, 30);
        give(&mut sim, 0, powerup::BOMB);
        let mut inputs = BTreeMap::new();
        inputs.insert(0, PlayerInput { yaw: 0.0, buttons: buttons::LIGHT, ..Default::default() });
        let mut exploded = false;
        let mut hit = false;
        for t in 0..200 {
            let evs = sim.step(&inputs);
            if t == 0 {
                inputs.insert(0, PlayerInput::default());
            }
            for ev in evs {
                if matches!(ev, SimEvent::Explosion { kind, .. } if kind == powerup::BOMB) {
                    exploded = true;
                }
                if matches!(ev, SimEvent::Hit { target: 1, .. }) {
                    hit = true;
                }
            }
        }
        assert!(exploded, "bomb should explode");
        assert!(hit, "explosion should launch the nearby player");
        assert!(sim.projectiles.is_empty(), "no projectiles should linger");
    }

    #[test]
    fn reset_round_clears_weapons() {
        let mut sim = GameSim::new(true);
        sim.add_player(0, false, [0.0, 1.05, 0.0]);
        sim.spawn_pickup(0, powerup::GUN, [5.0, 1.0, 5.0]);
        give(&mut sim, 0, powerup::GUN);
        sim.players.get_mut(&0).unwrap().state.fire_intent = true;
        sim.step(&BTreeMap::new());
        assert!(!sim.projectiles.is_empty(), "shot should exist");
        sim.reset_round();
        assert!(sim.pickups.is_empty());
        assert!(sim.projectiles.is_empty());
    }
}

#[cfg(test)]
mod island_reset_repro {
    use super::*;

    /// After a full shrink (islands included) and an arena_reset, players must
    /// be able to stand on EVERY island again.
    #[test]
    fn islands_solid_after_full_shrink_and_reset() {
        let c = consts();
        let mut sim = GameSim::new(true);
        // Run the arena schedule until absolutely everything has fallen.
        let all_gone = c.shrink_start_ticks
            + (c.arena_half_tiles as u32 + 1) * c.shrink_ring_interval_ticks
            + c.tile_warning_ticks
            + 10;
        sim.arena_apply_until(all_gone);
        assert!(sim.arena.tiles.iter().all(|t| t.state == TileState::Gone));

        // New round.
        sim.arena_reset();

        // Stand one player on each island center.
        let centers = Arena::island_centers();
        for (i, ctr) in centers.iter().enumerate() {
            sim.add_player(i as PlayerId, false, [ctr[0], 1.05, ctr[2]]);
        }
        let mut deaths = Vec::new();
        for _ in 0..240 {
            for ev in sim.step(&BTreeMap::new()) {
                if let SimEvent::Death { player, pos, .. } = ev {
                    deaths.push((player, pos));
                }
            }
        }
        assert!(
            deaths.is_empty(),
            "players fell through reset islands: {deaths:?}"
        );
    }
}
