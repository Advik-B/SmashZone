import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { ANIM, POWERUP_COLORS } from "../net/messages";

export const SLOT_COLORS = [
  0xff5e7d, 0x4dd2ff, 0xffd76e, 0x7dff8a, 0xc07dff, 0xff9c4d, 0x6e86ff,
  0x8affdf,
];

/** Client-only pseudo anim state: winner dance at match end. */
export const ANIM_DANCE = 100;

interface Template {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
  scale: number;
  footOffset: number;
}

let template: Template | null = null;

/** Load the shared character model once (CC0 RobotExpressive). */
export async function loadCharacterModel(): Promise<void> {
  try {
    const gltf = await new GLTFLoader().loadAsync("/assets/robot.glb");
    const scene = gltf.scene as THREE.Group;
    const bbox = new THREE.Box3().setFromObject(scene);
    const height = bbox.max.y - bbox.min.y;
    const scale = 2.0 / height; // capsule is 2.0 units tall
    template = {
      scene,
      clips: gltf.animations,
      scale,
      footOffset: -1.0 - bbox.min.y * scale,
    };
  } catch (e) {
    console.warn("character model failed to load, using capsules", e);
    template = null;
  }
}

interface ClipPlan {
  name: string;
  timeScale: number;
  once?: boolean;
}

/** AnimState (replicated) -> RobotExpressive clip. */
function planFor(anim: number): ClipPlan {
  switch (anim) {
    case ANIM.Run:
      return { name: "Running", timeScale: 1.3 };
    case ANIM.Air:
      return { name: "Jump", timeScale: 1.0, once: true };
    case ANIM.Dash:
      return { name: "Running", timeScale: 2.6 };
    case ANIM.WindupLight:
      return { name: "Punch", timeScale: 1.6 };
    case ANIM.SwingLight:
      return { name: "Punch", timeScale: 2.4 };
    case ANIM.WindupHeavy:
      return { name: "Punch", timeScale: 0.55 };
    case ANIM.SwingHeavy:
      return { name: "Punch", timeScale: 2.8 };
    case ANIM.Slam:
      return { name: "Jump", timeScale: 1.4, once: true };
    case ANIM.Launched:
      return { name: "Jump", timeScale: 0.8, once: true };
    case ANIM.Dead:
      return { name: "Death", timeScale: 1.0, once: true };
    case ANIM_DANCE:
      return { name: "Dance", timeScale: 1.0 };
    default:
      return { name: "Idle", timeScale: 1.0 };
  }
}

/**
 * One player's visual: animated glTF clone (or capsule fallback), name tag,
 * hit flash, launched tumble.
 */
export class PlayerVisual {
  group = new THREE.Group();
  private rig = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private tintedMats: THREE.MeshStandardMaterial[] = [];
  private lastAnim = -1;
  private animTime = 0;
  private flashTime = 0;
  private aura: THREE.Mesh;
  private auraMat: THREE.MeshBasicMaterial;
  private curPowerup = 0;
  readonly slotColor: number;
  private name: string;
  private nameCanvas: HTMLCanvasElement;
  private nameCtx: CanvasRenderingContext2D;
  private nameTex: THREE.CanvasTexture;
  private curDamage = -1;

  constructor(name: string, slot: number) {
    this.slotColor = SLOT_COLORS[slot % SLOT_COLORS.length];
    if (template) {
      this.buildModel(template);
    } else {
      this.buildCapsule();
    }
    // Powerup aura: flat glowing ring at the feet (in group, not rig, so it
    // stays level while the rig tumbles).
    this.auraMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    this.aura = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.07, 8, 32), this.auraMat);
    this.aura.rotation.x = Math.PI / 2;
    this.aura.position.y = -0.85;
    this.aura.visible = false;

    // Nameplate (name + live damage %), redrawn on damage change.
    this.name = name;
    this.nameCanvas = document.createElement("canvas");
    this.nameCanvas.width = 256;
    this.nameCanvas.height = 96;
    this.nameCtx = this.nameCanvas.getContext("2d")!;
    this.nameTex = new THREE.CanvasTexture(this.nameCanvas);
    const nameSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.nameTex, depthWrite: false }),
    );
    nameSprite.scale.set(2.4, 0.9, 1);
    nameSprite.position.y = 1.9;
    this.drawNameplate();

    this.group.add(this.rig, this.aura, nameSprite);
  }

  private drawNameplate() {
    const ctx = this.nameCtx;
    const cv = this.nameCanvas;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Name pill.
    ctx.font = "bold 34px system-ui, sans-serif";
    const w = Math.min(240, ctx.measureText(this.name).width + 32);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.roundRect(128 - w / 2, 6, w, 44, 12);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(this.name, 128, 28);
    // Damage % (heat ramp matching the HUD).
    if (this.curDamage > 0) {
      const heat = Math.min(1, this.curDamage / 150);
      ctx.font = "bold 30px system-ui, sans-serif";
      ctx.fillStyle = `rgb(255, ${Math.round(255 - heat * 190)}, ${Math.round(255 - heat * 230)})`;
      ctx.fillText(`${this.curDamage}%`, 128, 74);
    }
    this.nameTex.needsUpdate = true;
  }

  /** Update the nameplate's damage readout (redraws only on change). */
  setDamage(dmg: number) {
    if (dmg === this.curDamage) return;
    this.curDamage = dmg;
    this.drawNameplate();
  }

  setPowerup(kind: number) {
    if (kind === this.curPowerup) return;
    this.curPowerup = kind;
    this.aura.visible = kind > 0;
    if (kind > 0) {
      this.auraMat.color.setHex(POWERUP_COLORS[kind] ?? 0xffffff);
    }
  }

  private buildModel(tpl: Template) {
    const model = SkeletonUtils.clone(tpl.scene) as THREE.Group;
    model.scale.setScalar(tpl.scale);
    model.position.y = tpl.footOffset;
    const tint = new THREE.Color(this.slotColor);
    model.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const cloned = mats.map((m) => {
          const c = (m as THREE.MeshStandardMaterial).clone();
          // Tint the robot's main body color toward the slot color.
          if (c.name === "Main" || c.name === "Main.001") {
            c.color.lerp(tint, 0.85);
          }
          this.tintedMats.push(c);
          return c;
        });
        o.material = (cloned.length === 1 ? cloned[0] : cloned) as never;
      }
    });
    this.rig.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of tpl.clips) {
      this.actions.set(clip.name, this.mixer.clipAction(clip));
    }
  }

  private buildCapsule() {
    const mat = new THREE.MeshStandardMaterial({
      color: this.slotColor,
      roughness: 0.55,
    });
    this.tintedMats.push(mat);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.1, 6, 16), mat);
    body.castShadow = true;
    this.rig.add(body);
  }

  flash() {
    this.flashTime = 0.18;
  }

  private play(plan: ClipPlan) {
    if (!this.mixer) return;
    const action = this.actions.get(plan.name);
    if (!action) return;
    if (this.current === action) {
      action.timeScale = plan.timeScale;
      return;
    }
    action.reset();
    action.timeScale = plan.timeScale;
    if (plan.once) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    if (this.current) {
      action.crossFadeFrom(this.current, 0.12, false);
    }
    action.play();
    this.current = action;
  }

  update(anim: number, yaw: number, dtSec: number, powerupKind = 0) {
    this.setPowerup(powerupKind);
    if (anim !== this.lastAnim) {
      this.animTime = 0;
      this.lastAnim = anim;
      this.play(planFor(anim));
    }
    this.animTime += dtSec;

    if (this.aura.visible) {
      this.aura.rotation.z += dtSec * 1.8;
      const pulse = 1 + Math.sin(performance.now() / 130) * 0.08;
      this.aura.scale.setScalar(pulse);
    }

    // Dead players vanish (death burst covers the exit); dance stays visible.
    this.group.visible = anim !== ANIM.Dead || this.animTime < 1.2;
    this.group.rotation.y = yaw;

    // Launched: tumble the whole rig.
    if (anim === ANIM.Launched) {
      this.rig.rotation.x = this.animTime * 7;
    } else {
      this.rig.rotation.x = 0;
    }

    this.mixer?.update(dtSec);

    if (this.flashTime > 0) {
      this.flashTime -= dtSec;
      const k = Math.max(0, this.flashTime / 0.18) * 1.6;
      for (const m of this.tintedMats) {
        m.emissive.setRGB(1, 1, 1);
        m.emissiveIntensity = k;
      }
    } else if (this.tintedMats[0]?.emissiveIntensity !== 0) {
      for (const m of this.tintedMats) m.emissiveIntensity = 0;
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        // Geometry is shared with the template for model clones; only
        // dispose materials we cloned per-instance.
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) (m as THREE.Material).dispose();
      }
      if (o instanceof THREE.Sprite) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
  }
}
