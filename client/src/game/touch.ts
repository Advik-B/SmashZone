import { BTN_DASH, BTN_HEAVY, BTN_JUMP, BTN_LIGHT } from "../net/messages";
import type { InputManager } from "./input";

const TOUCH_LOOK_SENS = 0.0042;
const STICK_RADIUS = 56; // px from ring center to full deflection
const DEAD_ZONE = 0.12;

/**
 * On-screen controls for touch devices: a floating thumbstick on the left,
 * action buttons on the right, and drag-to-look everywhere else. Lives in its
 * own DOM root (not #ui, whose innerHTML is rebuilt on every phase change).
 */
export class TouchControls {
  private root: HTMLElement;
  private stickBase: HTMLElement;
  private stickKnob: HTMLElement;
  private lookZone: HTMLElement;

  private stickPointer: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookPointer: number | null = null;
  private lookLast = { x: 0, y: 0 };

  constructor(private input: InputManager) {
    this.root = document.createElement("div");
    this.root.id = "touch-controls";
    this.root.innerHTML = `
      <div class="tc-look"></div>
      <div class="tc-stick-zone"></div>
      <div class="tc-stick-base"><div class="tc-stick-knob"></div></div>
      <div class="tc-buttons">
        <button class="tc-btn tc-jump" data-bit="${BTN_JUMP}">JUMP</button>
        <button class="tc-btn tc-light" data-bit="${BTN_LIGHT}">
          <svg viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" fill="currentColor"/></svg>
        </button>
        <button class="tc-btn tc-heavy" data-bit="${BTN_HEAVY}">
          <svg viewBox="0 0 24 24"><path d="M12 2 3 7v5c0 5 3.8 8.4 9 10 5.2-1.6 9-5 9-10V7l-9-5z" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 7v6M9 10h6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
        </button>
        <button class="tc-btn tc-dash" data-bit="${BTN_DASH}">
          <svg viewBox="0 0 24 24"><path d="M4 6h9M2 12h11M4 18h9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M14 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>`;
    document.body.appendChild(this.root);

    this.lookZone = this.root.querySelector(".tc-look")!;
    this.stickBase = this.root.querySelector(".tc-stick-base")!;
    this.stickKnob = this.root.querySelector(".tc-stick-knob")!;
    const stickZone = this.root.querySelector<HTMLElement>(".tc-stick-zone")!;

    // --- thumbstick: anchors where the finger lands, floats until release ---
    stickZone.addEventListener("pointerdown", (e) => {
      if (this.stickPointer !== null) return;
      e.preventDefault();
      this.stickPointer = e.pointerId;
      stickZone.setPointerCapture(e.pointerId);
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickBase.style.left = `${e.clientX}px`;
      this.stickBase.style.top = `${e.clientY}px`;
      this.stickBase.classList.add("active");
      this.moveStick(e);
    });
    stickZone.addEventListener("pointermove", (e) => {
      if (e.pointerId === this.stickPointer) this.moveStick(e);
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.stickBase.classList.remove("active");
      this.stickBase.style.left = "";
      this.stickBase.style.top = "";
      this.stickKnob.style.transform = "translate(-50%, -50%)";
      this.input.setTouchMove(0, 0);
    };
    stickZone.addEventListener("pointerup", endStick);
    stickZone.addEventListener("pointercancel", endStick);

    // --- camera look: drag anywhere not claimed by stick/buttons ---
    this.lookZone.addEventListener("pointerdown", (e) => {
      if (this.lookPointer !== null) return;
      e.preventDefault();
      this.lookPointer = e.pointerId;
      this.lookZone.setPointerCapture(e.pointerId);
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    this.lookZone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.lookPointer) return;
      this.input.addCamDelta(e.clientX - this.lookLast.x, e.clientY - this.lookLast.y, TOUCH_LOOK_SENS);
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    const endLook = (e: PointerEvent) => {
      if (e.pointerId === this.lookPointer) this.lookPointer = null;
    };
    this.lookZone.addEventListener("pointerup", endLook);
    this.lookZone.addEventListener("pointercancel", endLook);

    // --- action buttons ---
    for (const btn of this.root.querySelectorAll<HTMLElement>(".tc-btn")) {
      const bit = Number(btn.dataset.bit);
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        btn.classList.add("pressed");
        this.input.touchPress(bit);
      });
      const release = () => {
        btn.classList.remove("pressed");
        this.input.touchRelease(bit);
      };
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
    }

    this.hide();
  }

  private moveStick(e: PointerEvent) {
    let dx = (e.clientX - this.stickOrigin.x) / STICK_RADIUS;
    let dy = (e.clientY - this.stickOrigin.y) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    this.stickKnob.style.transform = `translate(calc(-50% + ${dx * STICK_RADIUS}px), calc(-50% + ${
      dy * STICK_RADIUS
    }px))`;
    if (len < DEAD_ZONE) {
      this.input.setTouchMove(0, 0);
    } else {
      // Screen up = forward (+z), screen right = strafe right (+x).
      this.input.setTouchMove(dx, -dy);
    }
  }

  show() {
    this.root.style.display = "";
  }

  hide() {
    this.root.style.display = "none";
    this.stickPointer = null;
    this.lookPointer = null;
    this.stickBase.classList.remove("active");
    this.stickBase.style.left = "";
    this.stickBase.style.top = "";
    this.input.setTouchMove(0, 0);
    // Release anything held mid-press; pointerup won't fire once hidden.
    for (const btn of this.root.querySelectorAll<HTMLElement>(".tc-btn.pressed")) {
      btn.classList.remove("pressed");
      this.input.touchRelease(Number(btn.dataset.bit));
    }
  }
}
