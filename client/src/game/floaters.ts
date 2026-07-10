import * as THREE from "three";

const POOL = 24;
const LIFE = 0.7;
const POP_FRAC = 0.2; // first fraction of life: scale eases 1.35× → 1×

export interface FloaterOpts {
  heavy?: boolean;
  scale?: number;
  color?: string;
  life?: number;
}

interface Floater {
  sprite: THREE.Sprite;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  life: number;
  maxLife: number;
  scale: number;
  vy: number;
  base: THREE.Vector3;
}

/**
 * Pool of canvas-texture sprites for floating combat text (damage numbers).
 * Owned by the Renderer; recycles the oldest slot when the pool is full.
 */
export class Floaters {
  private items: Floater[] = [];
  private next = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < POOL; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }),
      );
      sprite.scale.set(1.6, 0.8, 1);
      sprite.visible = false;
      scene.add(sprite);
      this.items.push({
        sprite,
        tex,
        canvas,
        ctx,
        life: 0,
        maxLife: LIFE,
        scale: 1,
        vy: 0,
        base: new THREE.Vector3(),
      });
    }
  }

  spawn(pos: [number, number, number], text: string, opts: FloaterOpts = {}) {
    const f = this.items[this.next];
    this.next = (this.next + 1) % POOL;
    const { ctx, canvas } = f;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "bold 44px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.strokeText(text, 64, 32);
    ctx.fillStyle = opts.color ?? (opts.heavy ? "#ff9c4d" : "#ffffff");
    ctx.fillText(text, 64, 32);
    f.tex.needsUpdate = true;
    f.base.set(pos[0], pos[1] + 1.4, pos[2]);
    f.maxLife = opts.life ?? LIFE;
    f.life = f.maxLife;
    f.scale = opts.scale ?? 1;
    f.vy = 1.6;
    f.sprite.visible = true;
    f.sprite.position.copy(f.base);
    f.sprite.scale.set(1.6 * f.scale * 1.35, 0.8 * f.scale * 1.35, 1);
    (f.sprite.material as THREE.SpriteMaterial).opacity = 1;
  }

  update(dtSec: number) {
    for (const f of this.items) {
      if (f.life <= 0) continue;
      f.life -= dtSec;
      if (f.life <= 0) {
        f.sprite.visible = false;
        continue;
      }
      f.base.y += f.vy * dtSec;
      f.sprite.position.copy(f.base);
      // Pop-in: oversized at birth, settling to rest scale.
      const age = 1 - f.life / f.maxLife;
      const pop = 1 + 0.35 * Math.max(0, 1 - age / POP_FRAC);
      f.sprite.scale.set(1.6 * f.scale * pop, 0.8 * f.scale * pop, 1);
      (f.sprite.material as THREE.SpriteMaterial).opacity = Math.min(
        1,
        f.life / (f.maxLife * 0.6),
      );
    }
  }
}
