//! Shrinking tile arena. The shrink schedule is a pure function of the round
//! tick, so server and client compute identical tile states with no extra
//! network traffic: outer rings warn (flash), then fall, ring by ring.

use crate::constants::consts;
use crate::types::SimEvent;
use rapier3d::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TileState {
    Solid,
    Warning,
    Gone,
}

pub struct Tile {
    pub gx: i32,
    pub gz: i32,
    pub state: TileState,
    /// Sub-island tiles sit outside the main platform and fall last.
    pub island: bool,
    collider: Option<ColliderHandle>,
}

impl Tile {
    pub fn center(&self) -> [f32; 3] {
        let c = consts();
        [
            self.gx as f32 * c.arena_tile_size,
            -c.arena_tile_thickness / 2.0,
            self.gz as f32 * c.arena_tile_size,
        ]
    }

    fn ring(&self) -> i32 {
        self.gx.abs().max(self.gz.abs())
    }

    /// Tick (relative to round start) when this tile starts flashing.
    fn warn_tick(&self) -> u32 {
        let c = consts();
        if self.island {
            // Islands outlast even the center tile so they can't stall endgames
            // forever, but remain useful for most of the round.
            return c.shrink_start_ticks
                + (c.arena_half_tiles as u32 + 1) * c.shrink_ring_interval_ticks;
        }
        c.shrink_start_ticks
            + (c.arena_half_tiles - self.ring()) as u32 * c.shrink_ring_interval_ticks
    }

    fn fall_tick(&self) -> u32 {
        self.warn_tick() + consts().tile_warning_ticks
    }
}

pub struct Arena {
    pub tiles: Vec<Tile>,
    body: RigidBodyHandle,
}

impl Arena {
    pub fn new(bodies: &mut RigidBodySet, colliders: &mut ColliderSet) -> Arena {
        let c = consts();
        let body = bodies.insert(RigidBodyBuilder::fixed());
        let mut tiles = Vec::new();
        let half = c.arena_half_tiles;
        for gx in -half..=half {
            for gz in -half..=half {
                // Circular-ish mask so the platform has rounded corners.
                let d = ((gx * gx + gz * gz) as f32).sqrt();
                if d > half as f32 + 0.4 {
                    continue;
                }
                let mut tile = Tile {
                    gx,
                    gz,
                    state: TileState::Solid,
                    island: false,
                    collider: None,
                };
                tile.collider = Some(Self::make_collider(&tile, body, bodies, colliders));
                tiles.push(tile);
            }
        }

        // Four sub-islands on the diagonals, each side x side tiles.
        let base = c.island_base_tile;
        let side = c.island_tiles_per_side;
        for sx in [1, -1] {
            for sz in [1, -1] {
                for dx in 0..side {
                    for dz in 0..side {
                        let mut tile = Tile {
                            gx: sx * (base + dx),
                            gz: sz * (base + dz),
                            state: TileState::Solid,
                            island: true,
                            collider: None,
                        };
                        tile.collider = Some(Self::make_collider(&tile, body, bodies, colliders));
                        tiles.push(tile);
                    }
                }
            }
        }

        Arena { tiles, body }
    }

    /// Center point (top surface) of each island, in the same order the
    /// island tiles were generated (indexable 0..4).
    pub fn island_centers() -> Vec<[f32; 3]> {
        let c = consts();
        let mid = (c.island_base_tile as f32 + (c.island_tiles_per_side as f32 - 1.0) / 2.0)
            * c.arena_tile_size;
        let mut out = Vec::new();
        for sx in [1.0f32, -1.0] {
            for sz in [1.0f32, -1.0] {
                out.push([sx * mid, 0.0, sz * mid]);
            }
        }
        out
    }

    fn make_collider(
        tile: &Tile,
        body: RigidBodyHandle,
        bodies: &mut RigidBodySet,
        colliders: &mut ColliderSet,
    ) -> ColliderHandle {
        let c = consts();
        let center = tile.center();
        colliders.insert_with_parent(
            ColliderBuilder::cuboid(
                c.arena_tile_size / 2.0,
                c.arena_tile_thickness / 2.0,
                c.arena_tile_size / 2.0,
            )
            .translation(vector![center[0], center[1], center[2]])
            .friction(0.2),
            body,
            bodies,
        )
    }

    /// Advance tile states up to `round_tick` (ticks since the round started).
    /// Idempotent and monotonic: safe to call with the same or later tick.
    pub fn apply_until(
        &mut self,
        round_tick: u32,
        bodies: &mut RigidBodySet,
        colliders: &mut ColliderSet,
        islands: &mut IslandManager,
    ) -> Vec<SimEvent> {
        let mut events = Vec::new();
        for (i, tile) in self.tiles.iter_mut().enumerate() {
            if tile.state == TileState::Solid && round_tick >= tile.warn_tick() {
                tile.state = TileState::Warning;
                events.push(SimEvent::TileWarn { tile: i as u16 });
            }
            if tile.state == TileState::Warning && round_tick >= tile.fall_tick() {
                tile.state = TileState::Gone;
                if let Some(h) = tile.collider.take() {
                    colliders.remove(h, islands, bodies, true);
                }
                events.push(SimEvent::TileFall { tile: i as u16 });
            }
        }
        events
    }

    /// Restore every tile to Solid (new round).
    pub fn reset(&mut self, bodies: &mut RigidBodySet, colliders: &mut ColliderSet) {
        let body = self.body;
        for tile in &mut self.tiles {
            tile.state = TileState::Solid;
            if tile.collider.is_none() {
                tile.collider = Some(Self::make_collider(tile, body, bodies, colliders));
            }
        }
    }

    /// Debug audit: (live island colliders, total island tiles, live main, total main).
    /// A collider is "live" if the stored handle exists in the set at the
    /// tile's expected position.
    pub fn debug_audit(&self, colliders: &ColliderSet) -> (usize, usize, usize, usize) {
        let mut live_i = 0;
        let mut tot_i = 0;
        let mut live_m = 0;
        let mut tot_m = 0;
        for t in &self.tiles {
            let live = t
                .collider
                .and_then(|h| colliders.get(h))
                .map(|c| {
                    let p = c.translation();
                    let e = t.center();
                    (p.x - e[0]).abs() < 0.01 && (p.z - e[2]).abs() < 0.01
                })
                .unwrap_or(false);
            if t.island {
                tot_i += 1;
                if live {
                    live_i += 1;
                }
            } else {
                tot_m += 1;
                if live {
                    live_m += 1;
                }
            }
        }
        (live_i, tot_i, live_m, tot_m)
    }
}
