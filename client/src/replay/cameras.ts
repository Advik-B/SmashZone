// Replay camera rig — the three viewer modes:
//
// - "follow": the live third-person orbit rig aimed at a selectable player.
//   Look input rides InputManager (pointer-lock mouse-look, arrow keys in
//   keyboard mode) plus this rig's drag-look fallback, so it feels exactly
//   like spectating live.
// - "free": an unclamped fly camera owned by this rig. WASD moves along the
//   view direction, Space/Shift go up/down, wheel scales speed, mouse-look /
//   drag aims (full pitch range — the orbit clamp doesn't apply here).
// - "playerview": reconstructs what a player saw. The recording player gets
//   their exact recorded camera track (yaw AND pitch, 20 Hz-lerped);
//   everyone else gets a camera behind their wire yaw (u8-quantized, so
//   it's smoothed) at the standard orbit pitch — labeled approximate in
//   the UI, since aim pitch never crosses the wire.

import * as THREE from "three";
import { lerpAngle } from "../game/interp";
import type { InputManager } from "../game/input";
import type { Vec3 } from "../net/messages";
import type { ReplayDataset } from "./dataset";

export type ReplayCameraMode = "follow" | "free" | "playerview";

export interface CameraOverridePose {
  pos: Vec3;
  look: Vec3;
  fov?: number;
}

const FREE_SPEED_DEFAULT = 14;
const FREE_SPEED_MIN = 2;
const FREE_SPEED_MAX = 90;
const FREE_PITCH_LIMIT = 1.45; // just shy of straight up/down
const DRAG_SENS = 0.0035;
const KB_YAW_SPEED = 2.6;
const KB_PITCH_SPEED = 1.6;
/** Smoothing rate (1/s) hiding the u8 yaw steps in non-recorder POV. */
const PV_SMOOTH_RATE = 8;
const PV_PITCH = -0.45;

export class ReplayCameraRig {
  mode: ReplayCameraMode = "follow";

  private freePos = new THREE.Vector3(0, 8, -14);
  private freeYaw = Math.PI;
  private freePitch = -0.4;
  freeSpeed = FREE_SPEED_DEFAULT;

  private keys = new Set<string>();
  private dragId: number | null = null;
  private dragX = 0;
  private dragY = 0;

  private pvYaw = 0;
  private pvSeeded = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private input: InputManager,
    private camera: THREE.PerspectiveCamera,
  ) {}

  attach() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("wheel", this.onWheel, { passive: true });
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  detach() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
  }

  setMode(mode: ReplayCameraMode) {
    if (mode === this.mode) return;
    if (mode === "free") {
      // Seamless: start the fly camera exactly where the view already is.
      this.freePos.copy(this.camera.position);
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      this.freeYaw = Math.atan2(dir.x, dir.z);
      this.freePitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    } else if (this.mode === "free" && mode === "follow") {
      // Keep looking the way the fly camera was pointing.
      this.input.camYaw = this.freeYaw;
      this.input.camPitch = Math.max(-1.2, Math.min(0.15, this.freePitch));
    }
    if (mode === "playerview") this.pvSeeded = false;
    this.mode = mode;
  }

  /** Integrate the fly camera one frame and return the renderer pose. */
  updateFree(dtSec: number): CameraOverridePose {
    // Arrow keys turn (keyboard-friendly, mirrors the live keyboard camera).
    const yawIn = (this.keys.has("ArrowLeft") ? 1 : 0) - (this.keys.has("ArrowRight") ? 1 : 0);
    const pitchIn = (this.keys.has("ArrowUp") ? 1 : 0) - (this.keys.has("ArrowDown") ? 1 : 0);
    this.freeYaw += yawIn * KB_YAW_SPEED * dtSec;
    this.freePitch = clampFreePitch(this.freePitch + pitchIn * KB_PITCH_SPEED * dtSec);

    const cp = Math.cos(this.freePitch);
    const fwd = new THREE.Vector3(
      Math.sin(this.freeYaw) * cp,
      Math.sin(this.freePitch),
      Math.cos(this.freeYaw) * cp,
    );
    const right = new THREE.Vector3(-Math.cos(this.freeYaw), 0, Math.sin(this.freeYaw));

    const move = new THREE.Vector3();
    if (this.keys.has("KeyW")) move.add(fwd);
    if (this.keys.has("KeyS")) move.sub(fwd);
    if (this.keys.has("KeyD")) move.add(right);
    if (this.keys.has("KeyA")) move.sub(right);
    if (this.keys.has("Space")) move.y += 1;
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(this.freeSpeed * dtSec);
      this.freePos.add(move);
    }

    const look = this.freePos.clone().add(fwd);
    return {
      pos: [this.freePos.x, this.freePos.y, this.freePos.z],
      look: [look.x, look.y, look.z],
    };
  }

  /**
   * Orbit angles for "what this player saw". Exact for the recording player
   * (their camera track was recorded); yaw-behind + fixed pitch for others.
   */
  playerViewAngles(
    ds: ReplayDataset,
    playhead: number,
    targetId: number,
    targetYaw: number,
    dtSec: number,
  ): { yaw: number; pitch: number } {
    if (targetId === ds.header.localPlayerId) {
      return ds.camAt(playhead);
    }
    const desired = targetYaw + Math.PI; // camera sits behind the facing
    if (!this.pvSeeded) {
      this.pvSeeded = true;
      this.pvYaw = desired;
    } else {
      this.pvYaw = lerpAngle(this.pvYaw, desired, 1 - Math.exp(-PV_SMOOTH_RATE * dtSec));
    }
    return { yaw: this.pvYaw, pitch: PV_PITCH };
  }

  /** Re-seed player-view smoothing (target switch / big seek). */
  resetPlayerView() {
    this.pvSeeded = false;
  }

  // ---- listeners ----

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.dragId = null;
  };

  /** Pointer-locked mouse-look for the fly camera (follow mode's is in
   *  InputManager, which stays live during replay). */
  private onMouseMove = (e: MouseEvent) => {
    if (this.mode !== "free" || !document.pointerLockElement) return;
    this.freeYaw -= e.movementX * DRAG_SENS;
    this.freePitch = clampFreePitch(this.freePitch - e.movementY * DRAG_SENS);
  };

  private onWheel = (e: WheelEvent) => {
    if (this.mode !== "free") return;
    const factor = Math.pow(1.15, -e.deltaY / 100);
    this.freeSpeed = Math.max(FREE_SPEED_MIN, Math.min(FREE_SPEED_MAX, this.freeSpeed * factor));
  };

  // Drag-look on the canvas: touch aiming, and mouse aiming without pointer
  // lock (e.g. keyboard input mode where lock is never requested).
  private onPointerDown = (e: PointerEvent) => {
    if (document.pointerLockElement) return;
    this.dragId = e.pointerId;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.dragId !== e.pointerId) return;
    const dx = e.clientX - this.dragX;
    const dy = e.clientY - this.dragY;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    if (this.mode === "free") {
      this.freeYaw -= dx * DRAG_SENS;
      this.freePitch = clampFreePitch(this.freePitch - dy * DRAG_SENS);
    } else if (this.mode === "follow") {
      this.input.addCamDelta(dx, dy, DRAG_SENS);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.dragId === e.pointerId) this.dragId = null;
  };
}

function clampFreePitch(p: number): number {
  return Math.max(-FREE_PITCH_LIMIT, Math.min(FREE_PITCH_LIMIT, p));
}
