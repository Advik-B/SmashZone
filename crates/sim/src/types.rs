use serde::{Deserialize, Serialize};

pub type PlayerId = u8;

pub mod buttons {
    pub const JUMP: u8 = 1 << 0;
    pub const DASH: u8 = 1 << 1;
    pub const LIGHT: u8 = 1 << 2;
    pub const HEAVY: u8 = 1 << 3;
}

pub mod powerup {
    pub const NONE: u8 = 0;
    pub const HAMMER: u8 = 1;
    pub const ANCHOR: u8 = 2;
    pub const GUN: u8 = 3;
    pub const BOMB: u8 = 4;
}

/// One tick of player intent. move_x/move_z are a world-space direction
/// (already camera-rotated on the client), yaw is the facing/aim angle.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
pub struct PlayerInput {
    pub move_x: f32,
    pub move_z: f32,
    pub yaw: f32,
    pub buttons: u8,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AttackKind {
    #[default]
    None,
    Light,
    Heavy,
    /// Airborne light attack: fast, weak, 360° (appended — never reorder).
    AirLight,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
pub struct AttackState {
    pub kind: AttackKind,
    /// Ticks since the attack started; phases are windup -> active -> recovery.
    pub ticks: u8,
    /// Bitmask of player ids already hit by this swing (max 8 players).
    pub hit_mask: u8,
}

/// Everything about a character that is not the rigid body itself.
/// Must be Copy + serde so it can be snapshotted for client reconciliation.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
pub struct CharState {
    pub facing: f32,
    pub jump_count: u8,
    pub coyote: u8,
    pub dash_ticks: u8,
    pub dash_cd: u8,
    pub dash_dir: [f32; 2],
    pub attack: AttackState,
    pub launched: u16,
    pub slamming: bool,
    pub grounded: bool,
    pub prev_buttons: u8,
    /// Active powerup (see `powerup` consts) and remaining ticks.
    pub powerup: u8,
    pub powerup_ticks: u16,
    /// Gun/bomb rate limit; also set on the tick a shot is requested.
    pub fire_cd: u8,
    /// Set by movement when LIGHT is pressed holding gun/bomb; consumed
    /// (cleared) by the world step every tick on both server and client.
    pub fire_intent: bool,
    /// Invulnerability ticks (spawn protection); no damage/knockback while > 0.
    /// Added at the end (not reordered) so the CharSnapshot layout stays stable
    /// for the lockstep client/server reconciliation in a single build —
    /// postcard is positional, so this is not a cross-version wire guarantee.
    pub invuln: u16,
}

/// Precise local-player state sent to each client for prediction reconciliation.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct CharSnapshot {
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    pub state: CharState,
    pub damage: u16,
    pub alive: bool,
}

/// Discrete things that happened during a sim step; the server relays these
/// to clients for VFX/SFX and the room uses deaths to drive round flow.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum SimEvent {
    Hit {
        attacker: PlayerId,
        target: PlayerId,
        dir: [f32; 3],
        heavy: bool,
        damage: u16,
    },
    Slam {
        player: PlayerId,
        pos: [f32; 3],
    },
    Death {
        player: PlayerId,
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
        player: PlayerId,
        kind: u8,
    },
    Fired {
        player: PlayerId,
        kind: u8,
    },
    Explosion {
        pos: [f32; 3],
        kind: u8,
    },
}

/// Coarse animation state derived from CharState, sent quantized in snapshots
/// and mapped to animation clips client-side.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum AnimState {
    Idle = 0,
    Run = 1,
    Air = 2,
    Dash = 3,
    WindupLight = 4,
    SwingLight = 5,
    WindupHeavy = 6,
    SwingHeavy = 7,
    Slam = 8,
    Launched = 9,
    Dead = 10,
}

impl From<u8> for AnimState {
    fn from(v: u8) -> Self {
        match v {
            1 => AnimState::Run,
            2 => AnimState::Air,
            3 => AnimState::Dash,
            4 => AnimState::WindupLight,
            5 => AnimState::SwingLight,
            6 => AnimState::WindupHeavy,
            7 => AnimState::SwingHeavy,
            8 => AnimState::Slam,
            9 => AnimState::Launched,
            10 => AnimState::Dead,
            _ => AnimState::Idle,
        }
    }
}
