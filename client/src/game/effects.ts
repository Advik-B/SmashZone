import * as THREE from "three";

const MAX = 320;
const FLASH_POOL = 6;
const FLASH_LIFE = 0.12;

interface Flash {
  sprite: THREE.Sprite;
  life: number;
  scale: number;
}

/** Pooled particle burst system: one Points cloud, slots recycled. */
export class Effects {
  points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private next = 0;
  private budget = MAX;
  private geo: THREE.BufferGeometry;
  private flashes: Flash[] = [];
  private nextFlash = 0;
  private scratchCol = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.pos = new Float32Array(MAX * 3).fill(9999);
    this.col = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.16,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // Impact-flash sprites: one shared star texture, small fixed pool.
    const flashTex = makeFlashTexture();
    for (let i = 0; i < FLASH_POOL; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: flashTex,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
        }),
      );
      sprite.visible = false;
      scene.add(sprite);
      this.flashes.push({ sprite, life: 0, scale: 1 });
    }
  }

  /** Burst counts scale with the quality budget so low preset emits less. */
  private scaleCount(n: number): number {
    return Math.max(1, Math.round((n * this.budget) / MAX));
  }

  private spawn(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    speed: number,
    up: number,
    life: number,
  ) {
    const i = this.next;
    this.next = (this.next + 1) % this.budget;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    const a = Math.random() * Math.PI * 2;
    const s = (0.4 + Math.random() * 0.6) * speed;
    this.vel[i * 3] = Math.cos(a) * s;
    this.vel[i * 3 + 1] = up * (0.5 + Math.random());
    this.vel[i * 3 + 2] = Math.sin(a) * s;
    this.col[i * 3] = color.r;
    this.col[i * 3 + 1] = color.g;
    this.col[i * 3 + 2] = color.b;
    this.life[i] = life * (0.7 + Math.random() * 0.6);
  }

  /** Like spawn() but with velocity biased along a direction (plus spread). */
  private spawnDir(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    dir: [number, number, number],
    speed: number,
    up: number,
    life: number,
  ) {
    const i = this.next;
    this.next = (this.next + 1) % this.budget;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    const s = (0.4 + Math.random() * 0.6) * speed;
    const a = Math.random() * Math.PI * 2;
    const spread = s * 0.5;
    this.vel[i * 3] = dir[0] * s + Math.cos(a) * spread;
    this.vel[i * 3 + 1] = dir[1] * s * 0.6 + up * (0.5 + Math.random());
    this.vel[i * 3 + 2] = dir[2] * s + Math.sin(a) * spread;
    this.col[i * 3] = color.r;
    this.col[i * 3 + 1] = color.g;
    this.col[i * 3 + 2] = color.b;
    this.life[i] = life * (0.7 + Math.random() * 0.6);
  }

  hitBurst(p: THREE.Vector3, heavy: boolean) {
    const c = new THREE.Color(heavy ? 0xffb347 : 0xfff3a0);
    const n = this.scaleCount(heavy ? 26 : 14);
    for (let i = 0; i < n; i++) {
      this.spawn(p.x, p.y + 0.6, p.z, c, heavy ? 7 : 4.5, heavy ? 5 : 3.5, 0.5);
    }
  }

  /** Hit burst streaming along the knockback direction, scaled by damage. */
  impactBurst(
    p: THREE.Vector3,
    dir: [number, number, number],
    heavy: boolean,
    damage: number,
  ) {
    const base = heavy ? 0xffb347 : 0xfff3a0;
    const n = this.scaleCount(Math.min(34, Math.max(12, 10 + damage)));
    const speed = 4.5 + Math.min(1, Math.max(0, (damage - 8) / 18)) * 4.5;
    for (let i = 0; i < n; i++) {
      this.scratchCol.setHex(Math.random() < 0.3 ? 0xffffff : base);
      this.spawnDir(p.x, p.y + 0.6, p.z, this.scratchCol, dir, speed, heavy ? 4 : 3, 0.5);
    }
  }

  /** Additive star flash at an impact point (holds through hitstop). */
  spawnFlash(p: THREE.Vector3, scale = 1, colorHex = 0xffffff) {
    const f = this.flashes[this.nextFlash];
    this.nextFlash = (this.nextFlash + 1) % FLASH_POOL;
    f.life = FLASH_LIFE;
    f.scale = scale;
    f.sprite.position.copy(p);
    const mat = f.sprite.material as THREE.SpriteMaterial;
    mat.color.setHex(colorHex);
    mat.opacity = 1;
    mat.rotation = Math.random() * Math.PI;
    f.sprite.scale.setScalar(scale * 0.6);
    f.sprite.visible = true;
  }

  slamRing(p: THREE.Vector3) {
    const c = new THREE.Color(0x9be8ff);
    const n = this.scaleCount(30);
    for (let i = 0; i < n; i++) {
      this.spawn(p.x, p.y - 0.5, p.z, c, 8, 1.5, 0.45);
    }
  }

  deathBurst(p: THREE.Vector3, slotColor: number, vel?: [number, number, number]) {
    const c = new THREE.Color(slotColor);
    const n = this.scaleCount(40);
    // If the victim was flying, stream the burst along the launch trajectory.
    let dir: [number, number, number] | null = null;
    if (vel) {
      const m = Math.hypot(vel[0], vel[1], vel[2]);
      if (m > 4) dir = [vel[0] / m, vel[1] / m, vel[2] / m];
    }
    for (let i = 0; i < n; i++) {
      if (dir) this.spawnDir(p.x, p.y, p.z, c, dir, 6, 4, 0.8);
      else this.spawn(p.x, p.y, p.z, c, 6, 6, 0.8);
    }
  }

  /** Short-lived streak left behind while dashing (called per frame). */
  dashTrail(p: THREE.Vector3, slotColor: number) {
    const c = new THREE.Color(slotColor);
    for (let i = 0; i < 2; i++) {
      this.spawn(p.x, p.y + 0.5, p.z, c, 0.6, 0.3, 0.35);
    }
  }

  /** Hot streak behind a launched player (called per frame while flying). */
  launchTrail(p: THREE.Vector3) {
    for (let i = 0; i < 2; i++) {
      this.scratchCol.setHex(Math.random() < 0.5 ? 0xffffff : 0xffb347);
      this.spawn(p.x, p.y + 0.5, p.z, this.scratchCol, 0.5, 0.2, 0.45);
    }
  }

  /** Dust puff at the feet on landing. */
  landDust(p: THREE.Vector3) {
    this.scratchCol.setHex(0xcfc8ff);
    const n = this.scaleCount(8);
    for (let i = 0; i < n; i++) {
      this.spawn(p.x, p.y - 0.9, p.z, this.scratchCol, 2.5, 0.8, 0.35);
    }
  }

  /** Clamp the active particle count (quality setting). Retires excess slots. */
  setBudget(n: number) {
    this.budget = Math.max(1, Math.min(MAX, n));
    for (let i = this.budget; i < MAX; i++) {
      this.life[i] = 0;
      this.pos[i * 3 + 1] = 9999;
    }
    if (this.next >= this.budget) this.next = 0;
  }

  update(dtSec: number) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dtSec;
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = 9999;
        continue;
      }
      this.vel[i * 3 + 1] -= 18 * dtSec;
      this.pos[i * 3] += this.vel[i * 3] * dtSec;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dtSec;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dtSec;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dtSec;
      if (f.life <= 0) {
        f.sprite.visible = false;
        continue;
      }
      const t = 1 - f.life / FLASH_LIFE; // 0 → 1 over the flash
      f.sprite.scale.setScalar(f.scale * (0.6 + t));
      (f.sprite.material as THREE.SpriteMaterial).opacity = 1 - t * t;
    }
  }
}

/** Shared 4-point-star canvas texture for impact flashes. */
function makeFlashTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const g = canvas.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "rgba(255,255,255,0.95)";
  g.beginPath(); // vertical spike
  g.moveTo(64, 2);
  g.lineTo(71, 64);
  g.lineTo(64, 126);
  g.lineTo(57, 64);
  g.closePath();
  g.fill();
  g.beginPath(); // horizontal spike
  g.moveTo(2, 64);
  g.lineTo(64, 57);
  g.lineTo(126, 64);
  g.lineTo(64, 71);
  g.closePath();
  g.fill();
  return new THREE.CanvasTexture(canvas);
}
