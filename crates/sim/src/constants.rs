use serde::Deserialize;
use std::sync::OnceLock;

/// Tuning values shared with the TypeScript client via shared/constants.json.
/// Loaded once from the embedded JSON so both languages read identical numbers.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Constants {
    pub tick_rate: u32,
    pub snapshot_divisor: u32,

    pub gravity: f32,

    pub move_speed: f32,
    pub ground_accel: f32,
    pub air_accel: f32,
    pub air_control: f32,
    pub jump_velocity: f32,
    pub max_jumps: u8,
    pub coyote_ticks: u8,

    pub dash_speed: f32,
    pub dash_ticks: u8,
    pub dash_cooldown_ticks: u8,

    pub slam_velocity: f32,
    pub slam_radius: f32,
    pub slam_impulse: f32,
    pub slam_damage: u16,

    pub player_radius: f32,
    pub player_half_height: f32,
    pub player_mass: f32,

    pub light_windup_ticks: u8,
    pub light_active_ticks: u8,
    pub light_recovery_ticks: u8,
    pub light_reach: f32,
    pub light_hit_radius: f32,
    pub light_impulse: f32,
    pub light_damage: u16,

    pub heavy_windup_ticks: u8,
    pub heavy_active_ticks: u8,
    pub heavy_recovery_ticks: u8,
    pub heavy_reach: f32,
    pub heavy_hit_radius: f32,
    pub heavy_impulse: f32,
    pub heavy_damage: u16,

    pub hit_upward_bias: f32,
    pub launch_scale_per_damage: f32,
    pub launched_min_ticks: u16,

    pub kill_plane_y: f32,
    pub arena_tile_size: f32,
    pub arena_half_tiles: i32,
    pub arena_tile_thickness: f32,
    pub shrink_start_ticks: u32,
    pub shrink_ring_interval_ticks: u32,
    pub tile_warning_ticks: u32,

    pub island_base_tile: i32,
    pub island_tiles_per_side: i32,

    pub pickup_first_spawn_ticks: u32,
    pub pickup_spawn_interval_ticks: u32,
    pub pickup_radius: f32,
    pub powerup_duration_ticks: u16,
    pub hammer_mult: f32,
    pub anchor_mult: f32,
    pub gun_cooldown_ticks: u8,
    pub gun_speed: f32,
    pub gun_impulse: f32,
    pub gun_damage: u16,
    pub gun_ttl_ticks: u16,
    pub bomb_cooldown_ticks: u8,
    pub bomb_throw_speed: f32,
    pub bomb_throw_up: f32,
    pub bomb_fuse_ticks: u16,
    pub bomb_radius: f32,
    pub bomb_impulse: f32,
    pub bomb_damage: u16,

    pub round_countdown_ticks: u32,
    pub round_end_pause_ticks: u32,
    pub rounds_to_win: u8,
    pub respawn_height: f32,

    pub max_players: u8,

    pub pos_quant_scale: f32,
    pub vel_quant_scale: f32,

    pub interp_delay_ms: u32,
    pub reconcile_pos_error: f32,
    pub reconcile_vel_error: f32,
}

const RAW: &str = include_str!("../../../shared/constants.json");

pub fn consts() -> &'static Constants {
    static CONSTANTS: OnceLock<Constants> = OnceLock::new();
    CONSTANTS.get_or_init(|| serde_json::from_str(RAW).expect("shared/constants.json invalid"))
}

pub fn dt() -> f32 {
    1.0 / consts().tick_rate as f32
}
