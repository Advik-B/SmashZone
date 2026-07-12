//! Browser bindings: the same `sim` crate the server runs, compiled to WASM
//! for client-side prediction, plus protocol encode/decode so TypeScript
//! never touches byte layouts.

use protocol::{ClientMsg, InputMsg, Phase, ServerMsg, SnapshotMsg};
use serde::Serialize;
use sim::GameSim;
use sim::types::{CharSnapshot, PlayerInput, SimEvent};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

fn to_js<T: Serialize>(v: &T) -> JsValue {
    // json_compatible: plain JS objects instead of Maps.
    let ser = serde_wasm_bindgen::Serializer::json_compatible();
    v.serialize(&ser).unwrap_or(JsValue::NULL)
}

// ---- JS-friendly mirrors of the wire types (dequantized, camelCase) ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsPlayerMeta {
    id: u8,
    name: String,
    slot: u8,
    bot: bool,
    difficulty: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsPlayerState {
    id: u8,
    pos: [f32; 3],
    vel: [f32; 3],
    yaw: f32,
    anim: u8,
    grounded: bool,
    launched: bool,
    alive: bool,
    disconnected: bool,
    intangible: bool,
    damage: u16,
    powerup: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsPickup {
    id: u8,
    kind: u8,
    pos: [f32; 3],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsProjectile {
    id: u16,
    kind: u8,
    pos: [f32; 3],
    vel: [f32; 3],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsScore {
    id: u8,
    wins: u8,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
enum JsPhase {
    Lobby {
        host: u8,
    },
    Countdown {
        round: u8,
        start_tick: u32,
    },
    Playing {
        round: u8,
        round_start_tick: u32,
    },
    RoundEnd {
        winner: Option<u8>,
        scores: Vec<JsScore>,
    },
    MatchEnd {
        winner: u8,
        scores: Vec<JsScore>,
    },
}

impl From<&Phase> for JsPhase {
    fn from(p: &Phase) -> Self {
        match p {
            Phase::Lobby { host } => JsPhase::Lobby { host: *host },
            Phase::Countdown { round, start_tick } => JsPhase::Countdown {
                round: *round,
                start_tick: *start_tick,
            },
            Phase::Playing {
                round,
                round_start_tick,
            } => JsPhase::Playing {
                round: *round,
                round_start_tick: *round_start_tick,
            },
            Phase::RoundEnd { winner, scores } => JsPhase::RoundEnd {
                winner: *winner,
                scores: scores
                    .iter()
                    .map(|(id, wins)| JsScore {
                        id: *id,
                        wins: *wins,
                    })
                    .collect(),
            },
            Phase::MatchEnd { winner, scores } => JsPhase::MatchEnd {
                winner: *winner,
                scores: scores
                    .iter()
                    .map(|(id, wins)| JsScore {
                        id: *id,
                        wins: *wins,
                    })
                    .collect(),
            },
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
enum JsEvent {
    Hit {
        attacker: u8,
        target: u8,
        dir: [f32; 3],
        heavy: bool,
        damage: u16,
    },
    Slam {
        player: u8,
        pos: [f32; 3],
    },
    Death {
        player: u8,
        pos: [f32; 3],
        vel: [f32; 3],
    },
    TileWarn {
        tile: u16,
    },
    TileFall {
        tile: u16,
    },
    PickupSpawn {
        id: u8,
        kind: u8,
        pos: [f32; 3],
    },
    PickupTaken {
        id: u8,
        player: u8,
        kind: u8,
    },
    Fired {
        player: u8,
        kind: u8,
    },
    Explosion {
        pos: [f32; 3],
        kind: u8,
    },
}

impl From<&SimEvent> for JsEvent {
    fn from(e: &SimEvent) -> Self {
        match e {
            SimEvent::Hit {
                attacker,
                target,
                dir,
                heavy,
                damage,
            } => JsEvent::Hit {
                attacker: *attacker,
                target: *target,
                dir: *dir,
                heavy: *heavy,
                damage: *damage,
            },
            SimEvent::Slam { player, pos } => JsEvent::Slam {
                player: *player,
                pos: *pos,
            },
            SimEvent::Death { player, pos, vel } => JsEvent::Death {
                player: *player,
                pos: *pos,
                vel: *vel,
            },
            SimEvent::TileWarn { tile } => JsEvent::TileWarn { tile: *tile },
            SimEvent::TileFall { tile } => JsEvent::TileFall { tile: *tile },
            SimEvent::PickupSpawn { id, kind, pos } => JsEvent::PickupSpawn {
                id: *id,
                kind: *kind,
                pos: *pos,
            },
            SimEvent::PickupTaken { id, player, kind } => JsEvent::PickupTaken {
                id: *id,
                player: *player,
                kind: *kind,
            },
            SimEvent::Fired { player, kind } => JsEvent::Fired {
                player: *player,
                kind: *kind,
            },
            SimEvent::Explosion { pos, kind } => JsEvent::Explosion {
                pos: *pos,
                kind: *kind,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsSnapshot {
    tick: u32,
    last_input_seq: u16,
    input_buffer_len: u8,
    players: Vec<JsPlayerState>,
    pickups: Vec<JsPickup>,
    projectiles: Vec<JsProjectile>,
    local: Option<CharSnapshot>,
    events: Vec<JsEvent>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
enum JsServerMsg {
    Welcome {
        your_id: u8,
        code: String,
        players: Vec<JsPlayerMeta>,
        phase: JsPhase,
        tick: u32,
        token: String,
    },
    PlayerJoined {
        id: u8,
        name: String,
        slot: u8,
        bot: bool,
        difficulty: u8,
    },
    PlayerLeft {
        id: u8,
    },
    PhaseChange {
        phase: JsPhase,
        tick: u32,
    },
    Snapshot {
        snapshot: JsSnapshot,
    },
    Pong {
        t: u32,
    },
    Error {
        msg: String,
    },
}

fn convert_snapshot(s: &SnapshotMsg) -> JsSnapshot {
    JsSnapshot {
        tick: s.tick,
        last_input_seq: s.last_input_seq,
        input_buffer_len: s.input_buffer_len,
        players: s
            .players
            .iter()
            .map(|p| JsPlayerState {
                id: p.id,
                pos: [
                    protocol::dequant_pos(p.px),
                    protocol::dequant_pos(p.py),
                    protocol::dequant_pos(p.pz),
                ],
                vel: [
                    protocol::dequant_vel(p.vx),
                    protocol::dequant_vel(p.vy),
                    protocol::dequant_vel(p.vz),
                ],
                yaw: protocol::dequant_yaw_u8(p.yaw),
                anim: p.anim,
                grounded: p.flags & protocol::player_flags::GROUNDED != 0,
                launched: p.flags & protocol::player_flags::LAUNCHED != 0,
                alive: p.flags & protocol::player_flags::ALIVE != 0,
                disconnected: p.flags & protocol::player_flags::DISCONNECTED != 0,
                intangible: p.flags & protocol::player_flags::INTANGIBLE != 0,
                damage: p.damage,
                powerup: p.powerup,
            })
            .collect(),
        pickups: s
            .pickups
            .iter()
            .map(|k| JsPickup {
                id: k.id,
                kind: k.kind,
                pos: [
                    protocol::dequant_pos(k.px),
                    protocol::dequant_pos(k.py),
                    protocol::dequant_pos(k.pz),
                ],
            })
            .collect(),
        projectiles: s
            .projectiles
            .iter()
            .map(|pr| JsProjectile {
                id: pr.id,
                kind: pr.kind,
                pos: [
                    protocol::dequant_pos(pr.px),
                    protocol::dequant_pos(pr.py),
                    protocol::dequant_pos(pr.pz),
                ],
                vel: [
                    protocol::dequant_vel(pr.vx),
                    protocol::dequant_vel(pr.vy),
                    protocol::dequant_vel(pr.vz),
                ],
            })
            .collect(),
        local: s.local,
        events: s.events.iter().map(JsEvent::from).collect(),
    }
}

// ---- Protocol exports ----

#[wasm_bindgen]
pub fn decode_server_msg(bytes: &[u8]) -> JsValue {
    let Some(msg) = protocol::decode::<ServerMsg>(bytes) else {
        return JsValue::NULL;
    };
    let js = match &msg {
        ServerMsg::Welcome {
            your_id,
            code,
            players,
            phase,
            tick,
            token,
        } => JsServerMsg::Welcome {
            your_id: *your_id,
            code: code.clone(),
            players: players
                .iter()
                .map(|m| JsPlayerMeta {
                    id: m.id,
                    name: m.name.clone(),
                    slot: m.slot,
                    bot: m.bot,
                    difficulty: m.difficulty,
                })
                .collect(),
            phase: phase.into(),
            tick: *tick,
            token: token.clone(),
        },
        ServerMsg::PlayerJoined { meta } => JsServerMsg::PlayerJoined {
            id: meta.id,
            name: meta.name.clone(),
            slot: meta.slot,
            bot: meta.bot,
            difficulty: meta.difficulty,
        },
        ServerMsg::PlayerLeft { id } => JsServerMsg::PlayerLeft { id: *id },
        ServerMsg::PhaseChange { phase, tick } => JsServerMsg::PhaseChange {
            phase: phase.into(),
            tick: *tick,
        },
        ServerMsg::Snapshot(s) => JsServerMsg::Snapshot {
            snapshot: convert_snapshot(s),
        },
        ServerMsg::Pong { t } => JsServerMsg::Pong { t: *t },
        ServerMsg::Error { msg } => JsServerMsg::Error { msg: msg.clone() },
    };
    to_js(&js)
}

#[wasm_bindgen]
pub fn encode_input(seq: u16, move_x: f32, move_z: f32, yaw: f32, buttons: u8) -> Vec<u8> {
    protocol::encode(&ClientMsg::Input(InputMsg {
        seq,
        move_x: protocol::quant_move(move_x),
        move_z: protocol::quant_move(move_z),
        yaw: protocol::quant_yaw_u16(yaw),
        buttons,
    }))
}

#[wasm_bindgen]
pub fn encode_start_match() -> Vec<u8> {
    protocol::encode(&ClientMsg::StartMatch)
}

#[wasm_bindgen]
pub fn encode_rematch() -> Vec<u8> {
    protocol::encode(&ClientMsg::Rematch)
}

#[wasm_bindgen]
pub fn encode_ping(t: u32) -> Vec<u8> {
    protocol::encode(&ClientMsg::Ping { t })
}

#[wasm_bindgen]
pub fn encode_add_bot(difficulty: u8) -> Vec<u8> {
    protocol::encode(&ClientMsg::AddBot { difficulty })
}

#[wasm_bindgen]
pub fn encode_remove_bot(id: u8) -> Vec<u8> {
    protocol::encode(&ClientMsg::RemoveBot { id })
}

// ---- Prediction sim ----

#[wasm_bindgen]
pub struct ClientSim {
    sim: GameSim,
    local: u8,
}

#[wasm_bindgen]
impl ClientSim {
    #[wasm_bindgen(constructor)]
    pub fn new(local_id: u8) -> ClientSim {
        ClientSim {
            sim: GameSim::new(false),
            local: local_id,
        }
    }

    pub fn add_local(&mut self, x: f32, y: f32, z: f32) {
        self.sim.add_player(self.local, false, [x, y, z]);
    }

    pub fn add_proxy(&mut self, id: u8, x: f32, y: f32, z: f32) {
        self.sim.add_player(id, true, [x, y, z]);
    }

    pub fn remove_player(&mut self, id: u8) {
        self.sim.remove_player(id);
    }

    pub fn set_proxy(&mut self, id: u8, x: f32, y: f32, z: f32, yaw: f32) {
        self.sim.set_proxy_state(id, [x, y, z], yaw);
    }

    /// Step the local player one tick. Inputs are quantize-roundtripped so
    /// prediction sees exactly the values the server will decode.
    pub fn step_local(&mut self, move_x: f32, move_z: f32, yaw: f32, buttons: u8) {
        let input = PlayerInput {
            move_x: protocol::dequant_move(protocol::quant_move(move_x)),
            move_z: protocol::dequant_move(protocol::quant_move(move_z)),
            yaw: protocol::dequant_yaw_u16(protocol::quant_yaw_u16(yaw)),
            buttons,
        };
        let mut inputs = BTreeMap::new();
        inputs.insert(self.local, input);
        self.sim.step(&inputs);
    }

    /// Fast render path: [px, py, pz, vx, vy, vz, facing].
    pub fn local_kin(&self) -> Vec<f32> {
        match self.sim.snapshot(self.local) {
            Some(s) => vec![
                s.pos[0],
                s.pos[1],
                s.pos[2],
                s.vel[0],
                s.vel[1],
                s.vel[2],
                s.state.facing,
            ],
            None => vec![],
        }
    }

    pub fn local_anim(&self) -> u8 {
        self.sim.anim_state(self.local) as u8
    }

    pub fn local_snapshot(&self) -> JsValue {
        match self.sim.snapshot(self.local) {
            Some(s) => to_js(&s),
            None => JsValue::NULL,
        }
    }

    pub fn restore_local(&mut self, snap: JsValue) {
        if let Ok(s) = serde_wasm_bindgen::from_value::<CharSnapshot>(snap) {
            self.sim.restore(self.local, &s);
        }
    }

    /// Keep the prediction world's powerup in sync with the server without a
    /// full reconciliation snap (so gun/bomb fire is predicted correctly the
    /// moment a pickup is granted).
    pub fn set_local_powerup(&mut self, kind: u8, ticks: u16) {
        if let Some(p) = self.sim.players.get_mut(&self.local) {
            p.state.powerup = kind;
            p.state.powerup_ticks = ticks;
        }
    }

    pub fn arena_apply_until(&mut self, round_tick: u32) -> JsValue {
        let events: Vec<JsEvent> = self
            .sim
            .arena_apply_until(round_tick)
            .iter()
            .map(JsEvent::from)
            .collect();
        to_js(&events)
    }

    pub fn arena_reset(&mut self) {
        self.sim.arena_reset();
    }

    pub fn tile_centers(&self) -> Vec<f32> {
        self.sim.tile_centers()
    }

    pub fn tile_states(&self) -> Vec<u8> {
        self.sim.tile_states()
    }
}

/// Spawn circle helper (matches the server's placement).
#[wasm_bindgen]
pub fn spawn_positions(n: usize) -> Vec<f32> {
    GameSim::spawn_positions(n).into_iter().flatten().collect()
}
