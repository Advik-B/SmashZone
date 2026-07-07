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

/**
 * How the player aims: "pointer" is pointer-lock mouse-look, "keyboard" turns
 * the camera with the arrow keys (for trackpad users / keyboard-only play).
 */
export type InputMode = "pointer" | "keyboard";

export const INPUT_MODE_KEY = "sz-input-mode";

/** Saved mode; touch devices and unset/invalid values read as "pointer". */
export function savedInputMode(): InputMode {
  if (!isTouchDevice() && localStorage.getItem(INPUT_MODE_KEY) === "keyboard") {
    return "keyboard";
  }
  return "pointer";
}

const MOUSE_SENS = 0.0026;
/** Arrow-key camera turn rates (rad/s) in keyboard mode. */
const KB_YAW_SPEED = 2.6;
const KB_PITCH_SPEED = 1.6;
/** Auto-follow ease rate (1/s) and how long a manual turn suppresses it (s). */
const FOLLOW_RATE = 1.5;
const FOLLOW_GRACE = 1.0;

function clampPitch(p: number): number {
  return Math.max(-1.2, Math.min(0.15, p));
}

/**
 * True when the device's *primary* pointer is coarse (phones/tablets), so
 * hybrid laptops with a touchscreen but a mouse/trackpad keep desktop
 * controls (pointer lock, no on-screen sticks).
 */
export function isTouchDevice(): boolean {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(pointer: coarse)").matches;
  }
  return navigator.maxTouchPoints > 0;
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
  private _mode: InputMode = "pointer";
  /** Seconds left before auto-follow resumes after a manual arrow turn. */
  private followGrace = 0;
  pointerLocked = false;

  constructor(private canvas: HTMLCanvasElement) {}

  get mode(): InputMode {
    return this._mode;
  }

  setMode(m: InputMode) {
    this._mode = m;
    this.followGrace = 0;
    if (m === "keyboard" && this.pointerLocked) document.exitPointerLock();
  }

  attach() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", () => this.reset());
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  requestPointerLock() {
    if (this._mode === "keyboard") return; // arrows aim, keep the cursor free
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
    this.followGrace = 0;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.target instanceof HTMLInputElement) return; // typing in UI fields
    this.keys.add(e.code);
    const bit = this.bitForKey(e.code);
    this.latched |= bit;
    this.held |= bit;
    if (this._mode === "keyboard" && e.code === "KeyC") {
      this.camYaw = this.lastFacing; // snap the camera behind the player
    }
    const kbCam =
      this._mode === "keyboard" &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyC"].includes(e.code);
    if (bit || kbCam || ["KeyW", "KeyA", "KeyS", "KeyD"].includes(e.code)) {
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

  /**
   * Per-frame camera update for keyboard mode: arrow keys turn/pitch, and
   * while running forward the camera gently settles behind the movement
   * direction. Auto-follow strength scales with the *forward* component of
   * input and is zero for pure strafe/backpedal — easing toward the movement
   * yaw while it stays a fixed offset from the camera would otherwise spin
   * forever (the target moves with the camera).
   */
  update(dtSec: number) {
    if (this._mode !== "keyboard") return;
    const yawIn =
      (this.keys.has("ArrowLeft") ? 1 : 0) - (this.keys.has("ArrowRight") ? 1 : 0);
    const pitchIn =
      (this.keys.has("ArrowUp") ? 1 : 0) - (this.keys.has("ArrowDown") ? 1 : 0);
    if (yawIn || pitchIn) {
      this.camYaw += yawIn * KB_YAW_SPEED * dtSec;
      this.camPitch = clampPitch(this.camPitch + pitchIn * KB_PITCH_SPEED * dtSec);
      this.followGrace = FOLLOW_GRACE;
      return;
    }
    if (this.followGrace > 0) {
      this.followGrace -= dtSec;
      return;
    }
    let ix = 0;
    let iz = 0;
    if (this.keys.has("KeyW")) iz += 1;
    if (this.keys.has("KeyS")) iz -= 1;
    if (this.keys.has("KeyD")) ix += 1;
    if (this.keys.has("KeyA")) ix -= 1;
    const len = Math.hypot(ix, iz);
    if (len < 0.05 || iz <= 0) return;
    const off = Math.atan2(-ix, iz); // movement yaw relative to the camera
    this.camYaw += off * (1 - Math.exp(-(FOLLOW_RATE * iz / len) * dtSec));
  }

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
