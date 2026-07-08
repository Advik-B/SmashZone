import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import constants from "../../../shared/constants.json";
import { ANIM, PU_BOMB, POWERUP_COLORS } from "../net/messages";
import { Effects } from "./effects";
import { Floaters } from "./floaters";
import { PlayerVisual } from "./players";
import { QUALITY_PRESETS, type Quality } from "./quality";

/** Distinct low-poly shape per pickup kind (1=hammer, 2=anchor, 3=gun, 4=bomb). */
function buildPickupMesh(kind: number): THREE.Group {
  const g = new THREE.Group();
  const color = POWERUP_COLORS[kind] ?? 0xffffff;
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.45,
    roughness: 0.4,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22242e, roughness: 0.6 });
  switch (kind) {
    case 1: {
      // Hammer: head + handle.
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.32, 0.32), mat);
      head.position.y = 0.35;
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8), dark);
      g.add(head, handle);
      break;
    }
    case 2: {
      // Anchor: ring.
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.11, 10, 20), mat);
      g.add(ring);
      break;
    }
    case 3: {
      // Gun: L-shape.
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.18, 0.18), mat);
      barrel.position.y = 0.16;
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.16), dark);
      grip.position.set(-0.22, -0.08, 0);
      g.add(barrel, grip);
      break;
    }
    default: {
      // Bomb: sphere + fuse.
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 12), dark);
      const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.2, 6), mat);
      fuse.position.y = 0.38;
      g.add(ball, fuse);
      break;
    }
  }
  return g;
}

interface FallingTile {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

export class Renderer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private tileMeshes: THREE.Mesh[] = [];
  private tileCenters: number[][] = [];
  private tileMats: THREE.MeshStandardMaterial[] = [];
  private falling: FallingTile[] = [];
  // Shared resources for tile visuals (never disposed per-instance).
  private tileGeo: THREE.BoxGeometry | null = null;
  private fallingMat = new THREE.MeshStandardMaterial({
    color: 0x554488,
    roughness: 0.9,
  });
  private players = new Map<number, PlayerVisual>();
  private pickupMeshes = new Map<number, THREE.Group>();
  private projMeshes = new Map<number, THREE.Mesh>();
  private bulletGeo = new THREE.SphereGeometry(0.13, 8, 8);
  private bombGeo = new THREE.SphereGeometry(0.3, 12, 12);
  private bulletMat = new THREE.MeshBasicMaterial({ color: 0xffe94d });
  private bombMat = new THREE.MeshStandardMaterial({
    color: 0x22242e,
    emissive: 0xff3333,
    emissiveIntensity: 0.0,
  });
  effects: Effects;
  private floaters: Floaters;
  private shakeAmp = 0;
  private camPos = new THREE.Vector3(0, 8, -14);
  private followPos = new THREE.Vector3();
  private time = 0;
  private sun!: THREE.DirectionalLight;
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;
  private bloomEnabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Filmic tone mapping + sRGB output so the emissive-heavy art (auras,
    // pickups, bullets, bloom) reads as glow rather than flat oversaturation.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 300);
    this.resize();

    this.scene.background = new THREE.Color(0x11162e);
    this.scene.fog = new THREE.Fog(0x11162e, 40, 120);

    // Intensities bumped to compensate for ACES tone mapping dimming.
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x30243e, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.8);
    sun.position.set(14, 26, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 18;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = 80;
    this.scene.add(sun);
    this.sun = sun;

    // Decorative starfield below/around the arena.
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(600 * 3);
    for (let i = 0; i < 600; i++) {
      const r = 60 + Math.random() * 120;
      const a = Math.random() * Math.PI * 2;
      starPos[i * 3] = Math.cos(a) * r;
      starPos[i * 3 + 1] = -80 + Math.random() * 140;
      starPos[i * 3 + 2] = Math.sin(a) * r;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    this.scene.add(
      new THREE.Points(
        starGeo,
        new THREE.PointsMaterial({ color: 0x8a9cff, size: 0.35 }),
      ),
    );

    this.effects = new Effects(this.scene);
    this.floaters = new Floaters(this.scene);

    // Post-processing: subtle bloom so emissives actually glow.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.4, // strength
      0.5, // radius
      0.85, // threshold
    );
    this.composer.addPass(this.bloomPass);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Apply a quality preset (pixel ratio, shadows, bloom, particle budget). */
  applyQuality(q: Quality) {
    const p = QUALITY_PRESETS[q];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, p.dprCap));
    this.renderer.shadowMap.enabled = p.shadows;
    this.sun.castShadow = p.shadows;
    if (p.shadows && p.shadowRes > 0) {
      this.sun.shadow.mapSize.set(p.shadowRes, p.shadowRes);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null; // force realloc at the new size
    }
    // Materials must recompile for a shadow enable/disable to take effect.
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m.needsUpdate = true;
      }
    });
    this.bloomEnabled = p.bloom;
    this.effects.setBudget(p.particleBudget);
    this.resize();
  }

  /** Floating damage number at a world position. */
  spawnDamage(pos: [number, number, number], dmg: number, heavy: boolean) {
    this.floaters.spawn(pos, `${dmg}`, heavy);
  }

  /** Update a player's nameplate damage readout. */
  setPlayerDamage(id: number, dmg: number) {
    this.players.get(id)?.setDamage(dmg);
  }

  /** Current visual position of a player (for event-anchored VFX). */
  playerPos(id: number): THREE.Vector3 | null {
    const v = this.players.get(id);
    return v ? v.group.position.clone() : null;
  }

  playerColor(id: number): number {
    return this.players.get(id)?.slotColor ?? 0xffffff;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
  }

  /** Build tile meshes from the flat [x,y,z,...] centers array from WASM. */
  setTiles(centers: Float32Array | number[]) {
    for (const m of this.tileMeshes) m.removeFromParent();
    this.tileMeshes = [];
    this.tileMats = [];
    this.tileCenters = [];
    const size = constants.arenaTileSize;
    const thick = constants.arenaTileThickness;
    this.tileGeo ??= new THREE.BoxGeometry(size * 0.98, thick, size * 0.98);
    const geo = this.tileGeo;
    for (let i = 0; i * 3 < centers.length; i++) {
      const cx = centers[i * 3];
      const cy = centers[i * 3 + 1];
      const cz = centers[i * 3 + 2];
      this.tileCenters.push([cx, cy, cz]);
      const checker =
        (Math.round(cx / size) + Math.round(cz / size)) % 2 === 0;
      const mat = new THREE.MeshStandardMaterial({
        color: checker ? 0x8f7bd8 : 0x6f5cb8,
        roughness: 0.8,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, cy, cz);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.tileMeshes.push(mesh);
      this.tileMats.push(mat);
    }
  }

  /** 0 = solid, 1 = warning (flash), 2 = gone. */
  updateTiles(states: Uint8Array | number[]) {
    for (let i = 0; i < this.tileMeshes.length; i++) {
      const mesh = this.tileMeshes[i];
      const st = states[i];
      if (st === 2) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const mat = this.tileMats[i];
      if (st === 1) {
        const pulse = (Math.sin(this.time * 14) + 1) / 2;
        mat.emissive.setRGB(1, 0.15, 0.1);
        mat.emissiveIntensity = 0.25 + pulse * 0.6;
      } else {
        mat.emissiveIntensity = 0;
      }
    }
  }

  /** Cosmetic falling-tile chunk when a tile drops. */
  tileFall(tileIdx: number) {
    const c = this.tileCenters[tileIdx];
    if (!c || !this.tileGeo) return;
    const mesh = new THREE.Mesh(this.tileGeo, this.fallingMat);
    mesh.position.set(c[0], c[1], c[2]);
    this.scene.add(mesh);
    this.falling.push({
      mesh,
      vel: new THREE.Vector3((Math.random() - 0.5) * 2, -2, (Math.random() - 0.5) * 2),
      spin: new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, 0),
      life: 2.5,
    });
  }

  /** Sync pickup visuals to the authoritative list (diff by id). */
  setPickups(list: { id: number; kind: number; pos: [number, number, number] }[]) {
    const seen = new Set<number>();
    for (const pk of list) {
      seen.add(pk.id);
      let g = this.pickupMeshes.get(pk.id);
      if (!g || g.userData.kind !== pk.kind) {
        g?.removeFromParent();
        g = buildPickupMesh(pk.kind);
        g.userData.kind = pk.kind;
        this.scene.add(g);
        this.pickupMeshes.set(pk.id, g);
      }
      g.userData.base = pk.pos;
    }
    for (const [id, g] of this.pickupMeshes) {
      if (!seen.has(id)) {
        g.removeFromParent();
        this.pickupMeshes.delete(id);
      }
    }
  }

  /** Sync projectile visuals to the interpolated list (diff by id). */
  updateProjectiles(list: { id: number; kind: number; pos: [number, number, number] }[]) {
    const seen = new Set<number>();
    for (const pr of list) {
      seen.add(pr.id);
      let m = this.projMeshes.get(pr.id);
      if (!m) {
        m =
          pr.kind === PU_BOMB
            ? new THREE.Mesh(this.bombGeo, this.bombMat)
            : new THREE.Mesh(this.bulletGeo, this.bulletMat);
        this.scene.add(m);
        this.projMeshes.set(pr.id, m);
      }
      m.position.set(pr.pos[0], pr.pos[1], pr.pos[2]);
    }
    for (const [id, m] of this.projMeshes) {
      if (!seen.has(id)) {
        m.removeFromParent();
        this.projMeshes.delete(id);
      }
    }
  }

  /** Tear down all per-session visuals (players, pickups, projectiles,
   *  falling debris) so a reconnect can rebuild from a fresh Welcome. */
  reset() {
    for (const v of this.players.values()) v.dispose();
    this.players.clear();
    for (const g of this.pickupMeshes.values()) g.removeFromParent();
    this.pickupMeshes.clear();
    for (const m of this.projMeshes.values()) m.removeFromParent();
    this.projMeshes.clear();
    for (const f of this.falling) f.mesh.removeFromParent();
    this.falling = [];
  }

  addPlayer(id: number, name: string, slot: number) {
    this.removePlayer(id);
    const v = new PlayerVisual(name, slot);
    this.players.set(id, v);
    this.scene.add(v.group);
  }

  removePlayer(id: number) {
    this.players.get(id)?.dispose();
    this.players.delete(id);
  }

  setPlayerState(
    id: number,
    pos: [number, number, number],
    yaw: number,
    anim: number,
    dtSec: number,
    powerupKind = 0,
    intangible = false,
  ) {
    const v = this.players.get(id);
    if (!v) return;
    v.group.position.set(pos[0], pos[1], pos[2]);
    v.update(anim, yaw, dtSec, powerupKind, intangible);
    if (anim === ANIM.Dash) {
      this.effects.dashTrail(new THREE.Vector3(pos[0], pos[1], pos[2]), v.slotColor);
    }
  }

  flashPlayer(id: number) {
    this.players.get(id)?.flash();
  }

  shake(strength: number) {
    this.shakeAmp = Math.min(0.6, this.shakeAmp + strength);
  }

  render(dtSec: number, focus: [number, number, number], camYaw: number, camPitch: number) {
    this.time += dtSec;
    this.effects.update(dtSec);
    this.floaters.update(dtSec);

    // Pickups spin and bob; bombs blink faster as they age.
    for (const [id, g] of this.pickupMeshes) {
      const base = g.userData.base as [number, number, number] | undefined;
      if (base) {
        g.position.set(base[0], base[1] + Math.sin(this.time * 2.2 + id) * 0.14, base[2]);
      }
      g.rotation.y += dtSec * 1.6;
    }
    this.bombMat.emissiveIntensity = (Math.sin(this.time * 16) + 1) * 0.4;

    // Falling tiles.
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.life -= dtSec;
      f.vel.y += constants.gravity * dtSec;
      f.mesh.position.addScaledVector(f.vel, dtSec);
      f.mesh.rotation.x += f.spin.x * dtSec;
      f.mesh.rotation.y += f.spin.y * dtSec;
      if (f.life <= 0) {
        f.mesh.removeFromParent();
        this.falling.splice(i, 1);
      }
    }

    // Third-person orbit camera.
    this.followPos.lerp(new THREE.Vector3(focus[0], focus[1], focus[2]), 1 - Math.pow(0.001, dtSec));
    const dist = 9;
    const fx = Math.sin(camYaw) * Math.cos(camPitch);
    const fy = Math.sin(camPitch);
    const fz = Math.cos(camYaw) * Math.cos(camPitch);
    const target = new THREE.Vector3(
      this.followPos.x - fx * dist,
      Math.max(this.followPos.y - fy * dist + 1.5, constants.killPlaneY + 2),
      this.followPos.z - fz * dist,
    );
    this.camPos.lerp(target, 1 - Math.pow(0.0001, dtSec));

    // Screen shake.
    this.shakeAmp = Math.max(0, this.shakeAmp - dtSec * 2.5);
    const shake = new THREE.Vector3(
      (Math.random() - 0.5) * this.shakeAmp,
      (Math.random() - 0.5) * this.shakeAmp,
      (Math.random() - 0.5) * this.shakeAmp,
    );

    this.camera.position.copy(this.camPos).add(shake);
    this.camera.lookAt(
      this.followPos.x,
      this.followPos.y + 1.2,
      this.followPos.z,
    );
    if (this.bloomEnabled) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
