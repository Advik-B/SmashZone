import {
  BTN_DASH,
  BTN_HEAVY,
  BTN_JUMP,
  BTN_LIGHT,
} from "../net/messages";

export interface InputSample {
  moveX: number;
  moveZ: number;
  yaw: number;
  buttons: number;
}

const MOUSE_SENS = 0.0026;

function clampPitch(p: number): number {
  return Math.max(-1.2, Math.min(0.15, p));
}

/** Coarse-pointer devices (phones/tablets) get on-screen touch controls. */
export function isTouchDevice(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
}

export class InputManager {
  camYaw = Math.PI; // behind the player looking at center
  camPitch = -0.45;
  private keys = new Set<string>();
  /** Presses latched between samples so sub-tick clicks are never dropped. */
  private latched = 0;
  private held = 0;
  private lastFacing = 0;
  /** Local-space movement axes injected by the on-screen thumbstick. */
  private touchMoveX = 0;
  private touchMoveZ = 0;
  pointerLocked = false;

  constructor(private canvas: HTMLCanvasElement) {}

  attach() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  requestPointerLock() {
    if (isTouchDevice()) return; // touch aims by dragging, not pointer lock
    if (!this.pointerLocked) this.canvas.requestPointerLock();
  }

  /** Thumbstick input: x = strafe right, z = forward, each in [-1, 1]. */
  setTouchMove(x: number, z: number) {
    this.touchMoveX = x;
    this.touchMoveZ = z;
  }

  /** Press a button from the touch overlay (latched like a key press). */
  touchPress(bit: number) {
    this.latched |= bit;
    this.held |= bit;
  }

  touchRelease(bit: number) {
    this.held &= ~bit;
  }

  /** Rotate the camera by a screen-space drag delta (pixels). */
  addCamDelta(dx: number, dy: number, sens = MOUSE_SENS) {
    this.camYaw -= dx * sens;
    this.camPitch = clampPitch(this.camPitch - dy * sens);
  }

  private bitForKey(code: string): number {
    switch (code) {
      case "Space":
        return BTN_JUMP;
      case "ShiftLeft":
      case "ShiftRight":
        return BTN_DASH;
      case "KeyJ":
        return BTN_LIGHT;
      case "KeyK":
        return BTN_HEAVY;
      default:
        return 0;
    }
  }

  /** Clear all held/latched state (call on join and when menus open). */
  reset() {
    this.keys.clear();
    this.latched = 0;
    this.held = 0;
    this.touchMoveX = 0;
    this.touchMoveZ = 0;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.target instanceof HTMLInputElement) return; // typing in UI fields
    this.keys.add(e.code);
    const bit = this.bitForKey(e.code);
    this.latched |= bit;
    this.held |= bit;
    if (bit || ["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) {
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    this.held &= ~this.bitForKey(e.code);
  };

  private bitForMouse(button: number): number {
    if (button === 0) return BTN_LIGHT;
    if (button === 2) return BTN_HEAVY;
    return 0;
  }

  private onMouseDown = (e: MouseEvent) => {
    this.requestPointerLock();
    const bit = this.bitForMouse(e.button);
    this.latched |= bit;
    this.held |= bit;
  };

  private onMouseUp = (e: MouseEvent) => {
    this.held &= ~this.bitForMouse(e.button);
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.addCamDelta(e.movementX, e.movementY);
  };

  /** Sample one tick of input; world-space movement, camera-relative. */
  sample(): InputSample {
    let ix = 0;
    let iz = 0;
    if (this.keys.has("KeyW")) iz += 1;
    if (this.keys.has("KeyS")) iz -= 1;
    if (this.keys.has("KeyD")) ix += 1;
    if (this.keys.has("KeyA")) ix -= 1;
    ix += this.touchMoveX;
    iz += this.touchMoveZ;

    // Camera forward on the ground plane is (sin(camYaw), cos(camYaw)).
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);
    // Screen-right = forward x up.
    const rx = -fz;
    const rz = fx;
    let moveX = fx * iz + rx * ix;
    let moveZ = fz * iz + rz * ix;
    const len = Math.hypot(moveX, moveZ);
    if (len > 1) {
      moveX /= len;
      moveZ /= len;
    }

    const buttons = this.held | this.latched;
    this.latched = 0;

    // Face movement direction; when idle but attacking, face the camera way.
    if (len > 0.05) {
      this.lastFacing = Math.atan2(moveX, moveZ);
    } else if (buttons & (BTN_LIGHT | BTN_HEAVY)) {
      this.lastFacing = this.camYaw;
    }

    return { moveX, moveZ, yaw: this.lastFacing, buttons };
  }
}
