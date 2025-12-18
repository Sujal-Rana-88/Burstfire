import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { RemotePlayer } from "./net";
import { AnimationManager } from "./animation";

type WallRect = [number, number, number, number];

interface MeshEntry {
  mesh: THREE.Group;
  weapon: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  accentMat: THREE.MeshStandardMaterial;
  bobPhase: number;
  animManager?: AnimationManager;
}

const WORLD_HALF = 24;
const ARENA_SIZE = WORLD_HALF * 2;
const WALL_RECTS: WallRect[] = [
  [-18, 18, 18, 20],
  [-18, -6, 10, 12],
  [6, 18, 10, 12],
  [-18, -16, 10, 20],
  [16, 18, 10, 20],
  [-18, 18, -20, -18],
  [-18, -6, -12, -10],
  [6, 18, -12, -10],
  [-18, -16, -20, -10],
  [16, 18, -20, -10],
];
const PLATFORM_RECTS: Array<{ minX: number; maxX: number; minZ: number; maxZ: number; h: number }> = [
  { minX: -14.7, maxX: -13.3, minZ: -14.7, maxZ: -13.3, h: 1.4 },
  { minX: 13.3, maxX: 14.7, minZ: 13.3, maxZ: 14.7, h: 1.4 },
  { minX: -5.7, maxX: -4.3, minZ: -17.7, maxZ: -16.3, h: 1.4 },
  { minX: 4.3, maxX: 5.7, minZ: 16.3, maxZ: 17.7, h: 1.4 },
  { minX: -0.7, maxX: 0.7, minZ: -0.7, maxZ: 0.7, h: 1.4 },
];

const HUMAN_COLOR = 0x5f6c4d; // DOOM-ish marine green
const BOT_COLOR = 0xc46a24;

function makeNoiseTexture(color: THREE.ColorRepresentation, scale = 4, contrast = 0.22) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const base = new THREE.Color(color);
  const imageData = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const n = Math.random() * contrast;
      const r = Math.floor((base.r + n) * 255);
      const g = Math.floor((base.g + n) * 255);
      const b = Math.floor((base.b + n) * 255);
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(scale, scale);
  tex.needsUpdate = true;
  return tex;
}

function makeStripedTexture(color1: THREE.ColorRepresentation, color2: THREE.ColorRepresentation, stripe = 8, scale = 4) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c1 = new THREE.Color(color1);
  const c2 = new THREE.Color(color2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const use1 = Math.floor(x / stripe) % 2 === 0;
      ctx.fillStyle = use1 ? `rgb(${Math.floor(c1.r * 255)},${Math.floor(c1.g * 255)},${Math.floor(c1.b * 255)})`
        : `rgb(${Math.floor(c2.r * 255)},${Math.floor(c2.g * 255)},${Math.floor(c2.b * 255)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(scale, scale);
  tex.needsUpdate = true;
  return tex;
}

export class Renderer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 260);
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private clock = new THREE.Clock();
  private playerMeshes: Map<number, MeshEntry> = new Map();
  private baseModel: THREE.Group | null = null;
  private baseModelGltf: GLTF | null = null;
  private gun: THREE.Group | null = null;
  private pumpHandle: THREE.Mesh | null = null;
  private muzzleFlash: THREE.Mesh | null = null;
  private pumpPhase = 0; // 0 idle, 1 back, 2 forward
  private pumpTime = 0;
  private muzzleTime = 0;
  private recoil = 0;
  private wallHeight = 3.6;
  private listener = new THREE.AudioListener();
  private shotSound: THREE.Audio | null = null;
  private pumpSound: THREE.Audio | null = null;

  constructor() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(this.renderer.domElement);

    this.camera.add(this.listener);
    this.scene.background = new THREE.Color(0x0a0404); // Darker Doom-style background
    this.scene.fog = new THREE.Fog(0x0a0404, 12, WORLD_HALF * 2.2); // Thicker fog starting closer

    this.addLights();
    this.buildEnvironment();
    this.buildGun();
    this.loadCharacterModel();
    this.loadAudio();

    window.addEventListener("resize", () => this.onResize());
    this.onResize();
  }

  setCameraPose(x: number, y: number, z: number, yaw: number, pitch: number) {
    this.camera.position.set(x, y + 0.7, z);
    this.camera.rotation.set(pitch, yaw, 0, "YXZ");
  }

  triggerShotgunFire() {
    this.pumpPhase = 1;
    this.pumpTime = 0;
    this.muzzleTime = 0.08;
    this.recoil = 0.12;
    if (this.shotSound && this.shotSound.buffer) {
      this.shotSound.stop();
      this.shotSound.play();
    }
    if (this.muzzleFlash) {
      this.muzzleFlash.visible = true;
      this.muzzleFlash.scale.setScalar(1 + Math.random() * 0.2);
    }
  }

  updatePlayers(players: RemotePlayer[], localId: number | null) {
    const seen = new Set<number>();
    const t = performance.now() / 1000;

    for (const p of players) {
      if (!p.active) continue;
      seen.add(p.id);
      if (p.id === localId) continue;

      let entry = this.playerMeshes.get(p.id);
      if (!entry) {
        entry = this.createPlayerMesh();
        this.playerMeshes.set(p.id, entry);
        this.scene.add(entry.mesh);
      }

      const baseColor = p.isBot ? BOT_COLOR : HUMAN_COLOR;
      entry.bodyMat.color.setHex(baseColor);
      entry.accentMat.color.setHex(p.isBot ? 0x8b4c0f : 0x1f1b2f);
      const tintMats = (entry.mesh.userData as { tintMats?: THREE.MeshStandardMaterial[] }).tintMats;
      if (tintMats) {
        tintMats.forEach((m) => m.color.setHex(baseColor));
      }

      const speed = Math.hypot(p.vx, p.vz);

      // Update animation based on velocity
      if (entry.animManager) {
        if (speed > 5) {
          entry.animManager.playAnimation("run", true);
        } else if (speed > 0.5) {
          entry.animManager.playAnimation("walk", true);
        } else {
          entry.animManager.playAnimation("idle", true);
        }
      }

      // Manual bobbing only if no animation manager (fallback)
      const bob = entry.animManager ? 0 : Math.sin(t * 10 + entry.bobPhase) * Math.min(0.1, speed * 0.01);
      entry.mesh.position.set(p.x, p.y - 1.0 + bob, p.z);
      entry.mesh.rotation.y = p.yaw;
    }

    for (const [id, entry] of this.playerMeshes.entries()) {
      if (!seen.has(id)) {
        this.scene.remove(entry.mesh);
        this.playerMeshes.delete(id);
      }
    }
  }

  render() {
    const delta = this.clock.getDelta();
    this.updateAnimations(delta);
    this.renderer.render(this.scene, this.camera);
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  private addLights() {
    // Darker, more atmospheric Doom-style lighting
    const hemi = new THREE.HemisphereLight(0xaa6644, 0x0a0404, 0.35); // Dimmer, warmer
    this.scene.add(hemi);

    // Main directional light - much dimmer
    const dir = new THREE.DirectionalLight(0xffcc88, 0.3);
    dir.position.set(14, 18, 10);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -34;
    dir.shadow.camera.right = 34;
    dir.shadow.camera.top = 34;
    dir.shadow.camera.bottom = -34;
    dir.shadow.bias = -0.001;
    this.scene.add(dir);

    // Enhanced lava glow - more intense red/orange
    const lavaGlow = new THREE.PointLight(0xff2200, 2.5, 40, 2.5);
    lavaGlow.position.set(-8, 2.8, 0);
    lavaGlow.castShadow = true;
    this.scene.add(lavaGlow);

    // Exit glow - keep similar
    const exitGlow = new THREE.PointLight(0xdd1111, 1.2, 32, 2.0);
    exitGlow.position.set(10, 3.2, 12);
    this.scene.add(exitGlow);

    // Add flickering torch lights in corners for Doom atmosphere
    const torchPositions = [
      [-20, 2.5, -20],
      [20, 2.5, -20],
      [-20, 2.5, 20],
      [20, 2.5, 20]
    ];

    torchPositions.forEach(([x, y, z]) => {
      const torch = new THREE.PointLight(0xff8833, 1.5, 25, 2.2);
      torch.position.set(x, y, z);
      this.scene.add(torch);
    });
  }

  private buildEnvironment() {
    // Doom-style metal floor with darker tones
    const floorTex = makeStripedTexture(0x1a1512, 0x0f0c0a, 8, 12);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      metalness: 0.6,
      roughness: 0.4,
      emissive: 0x0a0606,
      emissiveIntensity: 0.1
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE, 1, 1), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Darker grid for Doom aesthetic
    const grid = new THREE.GridHelper(ARENA_SIZE, 32, 0x1a0808, 0x0a0404);
    grid.position.y = 0.02;
    this.scene.add(grid);

    // Doom-style stone walls with red tint
    const wallTex = makeNoiseTexture(0x2a1410, 8, 0.25);
    const wallMat = new THREE.MeshStandardMaterial({
      map: wallTex,
      metalness: 0.1,
      roughness: 0.8,
      emissive: 0x220a0a,
      emissiveIntensity: 0.15
    });
    this.buildPerimeter(wallMat);
    for (const rect of WALL_RECTS) {
      this.scene.add(this.makeWall(rect, wallMat));
    }

    this.addProps();
  }

  private buildPerimeter(wallMat: THREE.MeshStandardMaterial) {
    const thickness = 1.2;
    const h = this.wallHeight;
    const length = ARENA_SIZE + thickness * 2;
    const wallGeomX = new THREE.BoxGeometry(length, h, thickness);
    const wallGeomZ = new THREE.BoxGeometry(thickness, h, length);

    const north = new THREE.Mesh(wallGeomX, wallMat);
    north.position.set(0, h / 2, WORLD_HALF);
    const south = new THREE.Mesh(wallGeomX, wallMat);
    south.position.set(0, h / 2, -WORLD_HALF);
    const east = new THREE.Mesh(wallGeomZ, wallMat);
    east.position.set(WORLD_HALF, h / 2, 0);
    const west = new THREE.Mesh(wallGeomZ, wallMat);
    west.position.set(-WORLD_HALF, h / 2, 0);

    [north, south, east, west].forEach((w) => {
      w.castShadow = true;
      w.receiveShadow = true;
      this.scene.add(w);
    });
  }

  private makeWall([minX, maxX, minZ, maxZ]: WallRect, wallMat: THREE.MeshStandardMaterial) {
    const w = maxX - minX;
    const d = maxZ - minZ;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, this.wallHeight, d), wallMat);
    mesh.position.set((minX + maxX) / 2, this.wallHeight / 2, (minZ + maxZ) / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.2, d),
      new THREE.MeshStandardMaterial({ color: 0x5c1f1f, emissive: 0x220d0d, metalness: 0.32, roughness: 0.35 })
    );
    cap.position.set(mesh.position.x, mesh.position.y + this.wallHeight / 2 - 0.1, mesh.position.z);
    cap.castShadow = false;
    cap.receiveShadow = false;
    this.scene.add(cap);

    return mesh;
  }

  private addProps() {
    const crateTex = makeNoiseTexture(0x1a0f0a, 3, 0.18);
    crateTex.repeat.set(2, 2);
    const crateMat = new THREE.MeshStandardMaterial({
      map: crateTex,
      metalness: 0.45,
      roughness: 0.65,
      emissive: 0x1a0505,
      emissiveIntensity: 0.12
    });
    const crates: Array<{ x: number; y: number; z: number; minX: number; maxX: number; minZ: number; maxZ: number; h: number }> = [
      { x: -14, y: 0.8, z: -14, minX: -14.7, maxX: -13.3, minZ: -14.7, maxZ: -13.3, h: 1.4 },
      { x: 14, y: 0.8, z: 14, minX: 13.3, maxX: 14.7, minZ: 13.3, maxZ: 14.7, h: 1.4 },
      { x: -5, y: 0.8, z: -17, minX: -5.7, maxX: -4.3, minZ: -17.7, maxZ: -16.3, h: 1.4 },
      { x: 5, y: 0.8, z: 17, minX: 4.3, maxX: 5.7, minZ: 16.3, maxZ: 17.7, h: 1.4 },
      { x: 0, y: 0.8, z: 0, minX: -0.7, maxX: 0.7, minZ: -0.7, maxZ: 0.7, h: 1.4 },
    ];
    crates.forEach((c) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(c.maxX - c.minX, c.h, c.maxZ - c.minZ), crateMat);
      mesh.position.set(c.x, c.y, c.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    });
  }

  private buildGun() {
    const gun = new THREE.Group();
    const weapon = this.createShotgun(true, 1);
    weapon.position.set(0.42, -0.45, -1.05);
    weapon.rotation.set(-0.18, 0.3, 0.04);
    gun.add(weapon);
    this.camera.add(gun);
    this.gun = gun;
  }

  private createShotgun(firstPerson: boolean, scale: number) {
    const group = new THREE.Group();
    const baseColor = firstPerson ? 0x8f8a7a : 0x6f6a5c;
    const accentColor = 0xd14c1f;
    const bodyMat = new THREE.MeshStandardMaterial({ color: baseColor, metalness: 0.22, roughness: 0.45 });
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x1e1c1c, metalness: 0.6, roughness: 0.35 });
    const pumpMat = new THREE.MeshStandardMaterial({ color: 0x8c3b1a, metalness: 0.1, roughness: 0.6 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.38 * scale, 0.18 * scale, 0.9 * scale), bodyMat);
    body.position.set(0, -0.05 * scale, -0.3 * scale);

    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.32 * scale, 0.18 * scale, 0.55 * scale), bodyMat);
    stock.position.set(-0.08 * scale, -0.06 * scale, 0.35 * scale);
    stock.rotation.set(0.06, -0.1, 0.02);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * scale, 0.06 * scale, 1.25 * scale, 10), barrelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.06 * scale, -0.95 * scale);

    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.32 * scale, 0.16 * scale, 0.34 * scale), pumpMat);
    pump.position.set(0, -0.04 * scale, -0.65 * scale);

    const shellRack = new THREE.Mesh(
      new THREE.BoxGeometry(0.28 * scale, 0.08 * scale, 0.22 * scale),
      new THREE.MeshStandardMaterial({ color: accentColor, metalness: 0.35, roughness: 0.42 })
    );
    shellRack.position.set(0.08 * scale, 0.08 * scale, -0.05 * scale);

    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(0.14 * scale, 0.04 * scale, 0.8 * scale),
      new THREE.MeshStandardMaterial({ color: 0x1c1819, metalness: 0.15, roughness: 0.7 })
    );
    strap.position.set(-0.12 * scale, -0.12 * scale, -0.2 * scale);
    strap.rotation.set(0.15, 0.2, -0.05);

    [body, stock, barrel, pump, shellRack, strap].forEach((m) => {
      m.castShadow = true;
      m.receiveShadow = true;
    });

    group.add(body, stock, barrel, pump, shellRack, strap);

    const muzzle = new THREE.Mesh(new THREE.ConeGeometry(0.13 * scale, 0.22 * scale, 6), new THREE.MeshBasicMaterial({ color: 0xffc277 }));
    muzzle.rotation.x = Math.PI;
    muzzle.position.set(0, 0.02 * scale, -1.55 * scale);
    muzzle.visible = firstPerson;
    group.add(muzzle);

    if (firstPerson) {
      const leftHand = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.18), new THREE.MeshStandardMaterial({ color: 0xdcc8b1, roughness: 0.6 }));
      leftHand.position.set(-0.22, -0.16, -0.3);
      leftHand.rotation.set(-0.3, 0.4, 0.5);
      const rightHand = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.18), new THREE.MeshStandardMaterial({ color: 0xdcc8b1, roughness: 0.6 }));
      rightHand.position.set(0.1, -0.18, 0.18);
      rightHand.rotation.set(-0.08, -0.1, -0.3);
      group.add(leftHand, rightHand);
      this.pumpHandle = pump;

      const flash = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.5, 6), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9 }));
      flash.rotation.x = Math.PI;
      flash.position.set(0, 0.04, -1.6 * scale);
      flash.visible = false;
      group.add(flash);
      this.muzzleFlash = flash;
    }

    return group;
  }

  private createPlayerMesh(): MeshEntry {
    if (this.baseModel && this.baseModelGltf) {
      const cloned = SkeletonUtils.clone(this.baseModel) as THREE.Group;
      cloned.scale.set(0.8, 0.8, 0.8);
      cloned.rotation.y = Math.PI; // face down -Z to match forward
      cloned.position.y = 0;
      const tintMats: THREE.MeshStandardMaterial[] = [];
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && mesh.material) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.color.setHex(HUMAN_COLOR);
          mat.metalness = 0.42;
          mat.roughness = 0.38;
          mat.emissive.setHex(0x1a2415);
          mat.emissiveIntensity = 0.15;
          mat.needsUpdate = true;
          tintMats.push(mat);
        }
      });
      const weapon = this.createShotgun(false, 0.75);
      weapon.position.set(0.45, 1.15, -0.3);
      weapon.rotation.set(0.0, Math.PI, 0); // barrel forward
      weapon.castShadow = true;
      weapon.receiveShadow = true;
      cloned.add(weapon);
      cloned.userData.tintMats = tintMats;

      // Create animation manager for this player
      const animManager = new AnimationManager(this.baseModelGltf);
      // Start with idle animation if available
      if (animManager.hasAnimation("idle")) {
        animManager.playAnimation("idle", true);
      }

      return {
        mesh: cloned,
        weapon,
        bodyMat: new THREE.MeshStandardMaterial({ color: HUMAN_COLOR }),
        accentMat: new THREE.MeshStandardMaterial({ color: 0x262020 }),
        bobPhase: Math.random() * Math.PI * 2,
        animManager,
      };
    }

    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: HUMAN_COLOR,
      metalness: 0.42,
      roughness: 0.38,
      emissive: 0x1a2415,
      emissiveIntensity: 0.15
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: 0x262020,
      metalness: 0.48,
      roughness: 0.35,
      emissive: 0x0a0404,
      emissiveIntensity: 0.12
    });

    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.6, 0.42), accentMat);
    legs.position.y = 0.3;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.0, 0.5), bodyMat);
    torso.position.y = 1.0;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.54), accentMat);
    chest.position.set(0, 1.3, 0.04);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), accentMat);
    head.position.y = 1.75;
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.16, 0.04),
      new THREE.MeshStandardMaterial({ color: 0xf1c27d, emissive: 0xaa4f1a, emissiveIntensity: 0.55, roughness: 0.28, metalness: 0.32 })
    );
    visor.position.set(0, 1.75, 0.23);

    const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.22), bodyMat);
    leftArm.position.set(-0.55, 1.0, 0.05);
    const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.22), bodyMat);
    rightArm.position.set(0.55, 1.0, 0.05);

    const weapon = this.createShotgun(false, 0.65);
    weapon.position.set(0.4, 1.05, -0.25);
    weapon.rotation.set(0.0, Math.PI, 0);

    [legs, torso, chest, head, visor, leftArm, rightArm, weapon].forEach((m) => {
      m.castShadow = true;
      m.receiveShadow = true;
    });

    group.add(legs, torso, chest, head, visor, leftArm, rightArm, weapon);
    return { mesh: group, weapon, bodyMat, accentMat, bobPhase: Math.random() * Math.PI * 2 };
  }

  private loadAudio() {
    const loader = new THREE.AudioLoader();
    this.shotSound = new THREE.Audio(this.listener);
    this.pumpSound = new THREE.Audio(this.listener);
    loader.load("/audio/shotgun-fire.wav", (buffer) => {
      if (this.shotSound) {
        this.shotSound.setBuffer(buffer);
        this.shotSound.setVolume(0.55);
      }
    });
    loader.load("/audio/shotgun-pump.wav", (buffer) => {
      if (this.pumpSound) {
        this.pumpSound.setBuffer(buffer);
        this.pumpSound.setVolume(0.6);
      }
    });
  }

  private loadCharacterModel() {
    const loader = new GLTFLoader();
    loader.load(
      "/models/CesiumMan.glb",
      (gltf) => {
        this.baseModel = gltf.scene;
        this.baseModelGltf = gltf;
        console.log("Character model loaded. Available animations:", gltf.animations.map((a: THREE.AnimationClip) => a.name));
      },
      undefined,
      (err) => {
        console.warn("gltf load failed", err);
        this.baseModel = null;
        this.baseModelGltf = null;
      }
    );
  }

  private updateAnimations(delta: number) {
    // Update all player animations
    for (const entry of this.playerMeshes.values()) {
      if (entry.animManager) {
        entry.animManager.update(delta);
      }
    }

    if (!this.gun) return;

    if (this.muzzleFlash) {
      if (this.muzzleTime > 0) {
        this.muzzleTime -= delta;
        this.muzzleFlash.visible = true;
      } else {
        this.muzzleFlash.visible = false;
      }
    }

    // FPS gun recoil decay
    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - delta * 4);
    }
    this.gun.rotation.x = -0.18 - this.recoil * 0.8;
    this.gun.rotation.y = 0.3;
    this.gun.position.set(0.42, -0.45 - this.recoil * 0.2, -1.05);

    if (!this.pumpHandle) return;
    const pumpBackDur = 0.12;
    const pumpFwdDur = 0.16;
    const travel = 0.22;
    if (this.pumpPhase === 1) {
      this.pumpTime += delta;
      const t = Math.min(1, this.pumpTime / pumpBackDur);
      this.pumpHandle.position.z = -0.65 - travel * t;
      if (t >= 1) {
        this.pumpPhase = 2;
        this.pumpTime = 0;
        if (this.pumpSound && this.pumpSound.buffer) {
          this.pumpSound.stop();
          this.pumpSound.play();
        }
      }
    } else if (this.pumpPhase === 2) {
      this.pumpTime += delta;
      const t = Math.min(1, this.pumpTime / pumpFwdDur);
      this.pumpHandle.position.z = -0.65 - travel * (1 - t);
      if (t >= 1) {
        this.pumpPhase = 0;
        this.pumpTime = 0;
        this.pumpHandle.position.z = -0.65;
      }
    }
  }

  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
