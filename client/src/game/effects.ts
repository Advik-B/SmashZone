import * as THREE from "three";

const MAX = 320;

/** Pooled particle burst system: one Points cloud, slots recycled. */
export class Effects {
  points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private next = 0;
  private geo: THREE.BufferGeometry;

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
    this.next = (this.next + 1) % MAX;
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

  hitBurst(p: THREE.Vector3, heavy: boolean) {
    const c = new THREE.Color(heavy ? 0xffb347 : 0xfff3a0);
    const n = heavy ? 26 : 14;
    for (let i = 0; i < n; i++) {
      this.spawn(p.x, p.y + 0.6, p.z, c, heavy ? 7 : 4.5, heavy ? 5 : 3.5, 0.5);
    }
  }

  slamRing(p: THREE.Vector3) {
    const c = new THREE.Color(0x9be8ff);
    for (let i = 0; i < 30; i++) {
      this.spawn(p.x, p.y - 0.5, p.z, c, 8, 1.5, 0.45);
    }
  }

  deathBurst(p: THREE.Vector3, slotColor: number) {
    const c = new THREE.Color(slotColor);
    for (let i = 0; i < 40; i++) {
      this.spawn(p.x, p.y, p.z, c, 6, 6, 0.8);
    }
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
  }
}
