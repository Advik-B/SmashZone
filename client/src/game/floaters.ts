import * as THREE from "three";

const POOL = 24;
const LIFE = 0.7;

interface Floater {
  sprite: THREE.Sprite;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  life: number;
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
      this.items.push({ sprite, tex, canvas, ctx, life: 0, vy: 0, base: new THREE.Vector3() });
    }
  }

  spawn(pos: [number, number, number], text: string, heavy: boolean) {
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
    ctx.fillStyle = heavy ? "#ff9c4d" : "#ffffff";
    ctx.fillText(text, 64, 32);
    f.tex.needsUpdate = true;
    f.base.set(pos[0], pos[1] + 1.4, pos[2]);
    f.life = LIFE;
    f.vy = 1.6;
    f.sprite.visible = true;
    f.sprite.position.copy(f.base);
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
      (f.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, f.life / (LIFE * 0.6));
    }
  }
}
