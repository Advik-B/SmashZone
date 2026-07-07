//! Wire protocol: postcard-encoded binary messages over WebSocket.
//! The client encodes/decodes through the same code compiled to WASM,
//! so byte layout knowledge never has to exist in TypeScript.

use serde::{Deserialize, Serialize};
use sim::constants::consts;
use sim::types::{CharSnapshot, PlayerId, SimEvent};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlayerMeta {
    pub id: PlayerId,
    pub name: String,
    pub slot: u8,
}

/// Quantized per-tick input. move_x/move_z are -127..=127 mapped to -1..=1;
/// yaw is 0..=65535 mapped to 0..2pi.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct InputMsg {
    pub seq: u16,
    pub move_x: i8,
    pub move_z: i8,
    pub yaw: u16,
    pub buttons: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum ClientMsg {
    Input(InputMsg),
    StartMatch,
    Rematch,
    Ping { t: u32 },
}

/// Quantized remote-player state inside a snapshot.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct NetPlayer {
    pub id: PlayerId,
    pub px: i16,
    pub py: i16,
    pub pz: i16,
    pub vx: i16,
    pub vy: i16,
    pub vz: i16,
    pub yaw: u8,
    pub anim: u8,
    pub flags: u8,
    pub damage: u16,
    /// Active powerup kind (sim::types::powerup consts; 0 = none).
    pub powerup: u8,
}

/// Weapon pickup floating on an island.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct NetPickup {
    pub id: u8,
    pub kind: u8,
    pub px: i16,
    pub py: i16,
    pub pz: i16,
}

/// In-flight projectile (gun bullet / bomb).
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct NetProjectile {
    pub id: u16,
    pub kind: u8,
    pub px: i16,
    pub py: i16,
    pub pz: i16,
    pub vx: i16,
    pub vy: i16,
    pub vz: i16,
}

pub mod player_flags {
    pub const GROUNDED: u8 = 1 << 0;
    pub const LAUNCHED: u8 = 1 << 1;
    pub const ALIVE: u8 = 1 << 2;
    /// Player's socket dropped; slot held during the reconnect grace window.
    pub const DISCONNECTED: u8 = 1 << 3;
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SnapshotMsg {
    pub tick: u32,
    /// Highest input seq from the receiving client that the server has applied.
    pub last_input_seq: u16,
    /// Server-side input buffer length for the receiving client (clock sync).
    pub input_buffer_len: u8,
    pub players: Vec<NetPlayer>,
    pub pickups: Vec<NetPickup>,
    pub projectiles: Vec<NetProjectile>,
    /// Precise state of the receiving client's own character, for reconciliation.
    pub local: Option<CharSnapshot>,
    pub events: Vec<SimEvent>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum Phase {
    Lobby {
        host: PlayerId,
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
        winner: Option<PlayerId>,
        scores: Vec<(PlayerId, u8)>,
    },
    MatchEnd {
        winner: PlayerId,
        scores: Vec<(PlayerId, u8)>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum ServerMsg {
    Welcome {
        your_id: PlayerId,
        code: String,
        players: Vec<PlayerMeta>,
        phase: Phase,
        tick: u32,
        /// Session token: pass it back as `?token=` to rejoin this same slot
        /// (keeping id + score) after a dropped connection.
        token: String,
    },
    PlayerJoined {
        meta: PlayerMeta,
    },
    PlayerLeft {
        id: PlayerId,
    },
    PhaseChange {
        phase: Phase,
        tick: u32,
    },
    Snapshot(SnapshotMsg),
    Pong {
        t: u32,
    },
    Error {
        msg: String,
    },
}

pub fn encode<T: Serialize>(msg: &T) -> Vec<u8> {
    postcard::to_stdvec(msg).expect("protocol encode")
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Option<T> {
    postcard::from_bytes(bytes).ok()
}

// ---- Quantization helpers (used by server encode and wasm decode) ----

pub fn quant_pos(v: f32) -> i16 {
    (v * consts().pos_quant_scale).round().clamp(-32768.0, 32767.0) as i16
}

pub fn dequant_pos(v: i16) -> f32 {
    v as f32 / consts().pos_quant_scale
}

pub fn quant_vel(v: f32) -> i16 {
    (v * consts().vel_quant_scale).round().clamp(-32768.0, 32767.0) as i16
}

pub fn dequant_vel(v: i16) -> f32 {
    v as f32 / consts().vel_quant_scale
}

pub fn quant_yaw_u8(yaw: f32) -> u8 {
    let tau = std::f32::consts::TAU;
    (((yaw % tau) + tau) % tau / tau * 255.0).round() as u8
}

pub fn dequant_yaw_u8(v: u8) -> f32 {
    v as f32 / 255.0 * std::f32::consts::TAU
}

pub fn quant_yaw_u16(yaw: f32) -> u16 {
    let tau = std::f32::consts::TAU;
    (((yaw % tau) + tau) % tau / tau * 65535.0).round() as u16
}

pub fn dequant_yaw_u16(v: u16) -> f32 {
    v as f32 / 65535.0 * std::f32::consts::TAU
}

pub fn quant_move(v: f32) -> i8 {
    (v.clamp(-1.0, 1.0) * 127.0).round() as i8
}

pub fn dequant_move(v: i8) -> f32 {
    (v as f32 / 127.0).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_input() {
        let msg = ClientMsg::Input(InputMsg {
            seq: 4242,
            move_x: -90,
            move_z: 127,
            yaw: 30000,
            buttons: 0b1010,
        });
        let bytes = encode(&msg);
        let back: ClientMsg = decode(&bytes).unwrap();
        match back {
            ClientMsg::Input(i) => {
                assert_eq!(i.seq, 4242);
                assert_eq!(i.move_x, -90);
                assert_eq!(i.buttons, 0b1010);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn roundtrip_snapshot() {
        let msg = ServerMsg::Snapshot(SnapshotMsg {
            tick: 123456,
            last_input_seq: 999,
            input_buffer_len: 2,
            players: vec![NetPlayer {
                id: 3,
                px: quant_pos(4.25),
                py: quant_pos(1.0),
                pz: quant_pos(-7.5),
                vx: quant_vel(2.0),
                vy: quant_vel(-9.0),
                vz: quant_vel(0.0),
                yaw: quant_yaw_u8(1.57),
                anim: 1,
                flags: player_flags::ALIVE | player_flags::GROUNDED,
                damage: 47,
                powerup: 3,
            }],
            pickups: vec![NetPickup {
                id: 2,
                kind: 1,
                px: quant_pos(13.0),
                py: quant_pos(1.0),
                pz: quant_pos(-13.0),
            }],
            projectiles: vec![NetProjectile {
                id: 9,
                kind: 3,
                px: quant_pos(1.0),
                py: quant_pos(1.5),
                pz: quant_pos(2.0),
                vx: quant_vel(28.0),
                vy: quant_vel(0.0),
                vz: quant_vel(0.0),
            }],
            local: None,
            events: vec![sim::types::SimEvent::TileWarn { tile: 12 }],
        });
        let bytes = encode(&msg);
        let back: ServerMsg = decode(&bytes).unwrap();
        match back {
            ServerMsg::Snapshot(s) => {
                assert_eq!(s.tick, 123456);
                assert!((dequant_pos(s.players[0].px) - 4.25).abs() < 0.01);
                assert_eq!(s.players[0].powerup, 3);
                assert_eq!(s.pickups[0].kind, 1);
                assert_eq!(s.projectiles[0].id, 9);
                assert!((dequant_vel(s.projectiles[0].vx) - 28.0).abs() < 0.1);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn quant_precision() {
        for v in [-60.0f32, -1.234, 0.0, 0.004, 12.7, 100.0] {
            assert!((dequant_pos(quant_pos(v)) - v).abs() < 0.005);
        }
    }
}
