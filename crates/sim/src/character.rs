//! Character movement: runs identically on the server (native) and in the
//! browser (WASM) for client-side prediction. Everything here must be a pure
//! function of (body, state, input, constants) — no RNG, no clocks.

use crate::constants::{Constants, consts, dt};
use crate::types::{AttackKind, CharState, PlayerInput, buttons, powerup};
use rapier3d::prelude::*;

#[derive(PartialEq, Eq, Clone, Copy, Debug)]
pub enum AttackPhase {
    None,
    Windup,
    Active,
    Recovery,
}

pub fn attack_phase(st: &CharState) -> AttackPhase {
    let c = consts();
    let (w, a, r) = match st.attack.kind {
        AttackKind::None => return AttackPhase::None,
        AttackKind::Light => (
            c.light_windup_ticks,
            c.light_active_ticks,
            c.light_recovery_ticks,
        ),
        AttackKind::Heavy => (
            c.heavy_windup_ticks,
            c.heavy_active_ticks,
            c.heavy_recovery_ticks,
        ),
        AttackKind::AirLight => (
            c.air_light_windup_ticks,
            c.air_light_active_ticks,
            c.air_light_recovery_ticks,
        ),
    };
    let t = st.attack.ticks;
    if t < w {
        AttackPhase::Windup
    } else if t < w + a {
        AttackPhase::Active
    } else if t < w + a + r {
        AttackPhase::Recovery
    } else {
        AttackPhase::None
    }
}

pub fn facing_dir(yaw: f32) -> Vector<f32> {
    vector![yaw.sin(), 0.0, yaw.cos()]
}

/// Advance one tick of movement for a simulated character.
/// `st.grounded` must already be set from this tick's ground check.
pub fn tick_movement(body: &mut RigidBody, st: &mut CharState, input: &PlayerInput) {
    let c: &Constants = consts();
    let dt = dt();
    let pressed = input.buttons & !st.prev_buttons;
    st.prev_buttons = input.buttons;

    // -- timers --
    if st.dash_cd > 0 {
        st.dash_cd -= 1;
    }
    if st.fire_cd > 0 {
        st.fire_cd -= 1;
    }
    if st.invuln > 0 {
        st.invuln -= 1;
    }
    if st.powerup_ticks > 0 {
        st.powerup_ticks -= 1;
        if st.powerup_ticks == 0 {
            st.powerup = powerup::NONE;
        }
    }
    if st.coyote > 0 && !st.grounded {
        st.coyote -= 1;
    }
    if st.grounded {
        st.jump_count = 0;
        st.coyote = c.coyote_ticks;
    }
    if st.launched > 0 {
        st.launched -= 1;
        // Landing recovers you from launch early.
        if st.grounded && st.launched < c.launched_min_ticks {
            st.launched = 0;
        }
    }

    // -- attack progression --
    if st.attack.kind != AttackKind::None {
        st.attack.ticks = st.attack.ticks.saturating_add(1);
        if attack_phase(st) == AttackPhase::None {
            st.attack = Default::default();
        }
    }

    let attacking = st.attack.kind != AttackKind::None;
    let can_act = st.launched == 0 && !st.slamming && !attacking && st.dash_ticks == 0;

    // Facing: the client sends the yaw it wants (movement dir or aim).
    if can_act || attacking {
        st.facing = input.yaw;
    }

    let mut move_vec = vector![input.move_x, 0.0, input.move_z];
    if move_vec.norm() > 1.0 {
        move_vec = move_vec.normalize();
    }

    // -- dash --
    if pressed & buttons::DASH != 0 && st.dash_cd == 0 && can_act {
        let dir = if move_vec.norm() > 0.1 {
            move_vec.normalize()
        } else {
            facing_dir(st.facing)
        };
        st.dash_dir = [dir.x, dir.z];
        st.dash_ticks = c.dash_ticks;
        st.dash_cd = c.dash_cooldown_ticks;
        st.invuln = 0; // going on the offensive drops spawn protection
    }
    if st.dash_ticks > 0 {
        st.dash_ticks -= 1;
        // Horizontal burst; gravity suspended for the dash duration.
        body.set_linvel(
            vector![
                st.dash_dir[0] * c.dash_speed,
                0.0,
                st.dash_dir[1] * c.dash_speed
            ],
            true,
        );
        return;
    }

    // -- slam (heavy while airborne) --
    if pressed & buttons::HEAVY != 0 && !st.grounded && can_act {
        st.slamming = true;
        st.invuln = 0;
    }
    if st.slamming {
        let v = *body.linvel();
        body.set_linvel(vector![v.x * 0.9, c.slam_velocity, v.z * 0.9], true);
        return;
        // Landing resolution (AoE + clearing the flag) happens in world.rs,
        // because it needs scene queries.
    }

    // -- attacks / firing --
    let ranged = st.powerup == powerup::GUN || st.powerup == powerup::BOMB;
    if can_act {
        // Any attack input drops spawn protection (offense cancels invuln).
        if pressed & (buttons::LIGHT | buttons::HEAVY) != 0 {
            st.invuln = 0;
        }
        if pressed & buttons::LIGHT != 0 {
            if ranged {
                // Holding a gun/bomb: LIGHT fires instead of swinging.
                if st.fire_cd == 0 {
                    st.fire_intent = true;
                    st.fire_cd = if st.powerup == powerup::GUN {
                        c.gun_cooldown_ticks
                    } else {
                        c.bomb_cooldown_ticks
                    };
                }
            } else {
                // In the air, LIGHT is a fast weak 360° spin (AirLight).
                st.attack.kind = if st.grounded {
                    AttackKind::Light
                } else {
                    AttackKind::AirLight
                };
                st.attack.ticks = 0;
                st.attack.hit_mask = 0;
            }
        } else if pressed & buttons::HEAVY != 0 && st.grounded {
            st.attack.kind = AttackKind::Heavy;
            st.attack.ticks = 0;
            st.attack.hit_mask = 0;
        }
    }

    // -- jump --
    let may_jump = st.launched == 0 && !st.slamming;
    if pressed & buttons::JUMP != 0 && may_jump {
        let v = *body.linvel();
        if st.grounded || st.coyote > 0 {
            body.set_linvel(vector![v.x, c.jump_velocity, v.z], true);
            st.jump_count = 1;
            st.coyote = 0;
        } else {
            if st.jump_count == 0 {
                // Walked off a ledge: the air jump is the second jump.
                st.jump_count = 1;
            }
            if st.jump_count < c.max_jumps {
                body.set_linvel(vector![v.x, c.jump_velocity, v.z], true);
                st.jump_count += 1;
            }
        }
    }

    // -- directional influence while launched --
    // A small additive nudge steers the launch trajectory without braking it
    // toward walk speed (which the old "steer toward target" code did).
    if st.launched > 0 {
        let v = *body.linvel();
        let cur = vector![v.x, 0.0, v.z];
        let nv = cur + move_vec * c.di_accel * dt;
        body.set_linvel(vector![nv.x, v.y, nv.z], true);
        return;
    }

    // -- horizontal velocity control --
    let attack_slow = if attacking { 0.35 } else { 1.0 };
    let target = move_vec * c.move_speed * attack_slow;
    let accel = if st.grounded {
        c.ground_accel
    } else {
        c.air_accel * c.air_control
    };
    let v = *body.linvel();
    let cur = vector![v.x, 0.0, v.z];
    let mut delta = target - cur;
    let max_dv = accel * dt;
    if delta.norm() > max_dv {
        delta = delta.normalize() * max_dv;
    }
    let nv = cur + delta;
    body.set_linvel(vector![nv.x, v.y, nv.z], true);
}
