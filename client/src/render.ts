import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { RemotePlayer } from "./net";
import { AnimationManager } from "./animation";
import { WORLD_HALF } from "./map";

interface MeshEntry {
  mesh: THREE.Group;
  weapon: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  accentMat: THREE.MeshStandardMaterial;
  bobPhase: number;
  animManager?: AnimationManager;
}

const HUMAN_COLOR = 0x5f6c4d; // DOOM-ish marine green
const BOT_COLOR = 0xc46a24;

// Removed: texture generation functions - not needed for simple city map

export class Renderer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 260);
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private clock = new THREE.Clock();
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;
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
  private listener = new THREE.AudioListener();
  private shotSound: THREE.Audio | null = null;
  private pumpSound: THREE.Audio | null = null;
  private cityGroup = new THREE.Group(); // Container for generated city scene

  constructor() {
    this.renderer.physicallyCorrectLights = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(this.renderer.domElement);

    // Subtle HDR room environment for believable metal reflections
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTex;
    pmrem.dispose();

    this.composer = new EffectComposer(this.renderer);
    const renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.28, 0.82);
    this.bloomPass.threshold = 0.75;
    this.bloomPass.strength = 0.42;
    this.bloomPass.radius = 0.62;
    this.composer.addPass(renderPass);
    this.composer.addPass(this.bloomPass);

    this.camera.add(this.listener);
    this.scene.background = new THREE.Color(0x87ceeb); // Sky blue for campus
    this.scene.fog = new THREE.Fog(0x87ceeb, 50, WORLD_HALF * 3.5);
    this.scene.add(this.cityGroup); // Add city container to scene

    this.addLights();
    this.buildSky();
    this.buildCity(); // Build simple city block map
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
        const created = this.createPlayerMesh();
        if (!created) continue; // model not ready yet
        entry = created;
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
      const airborne = Math.abs(p.vy) > 1.2 && p.y > 1.2;

      // Update animation based on velocity
      if (entry.animManager) {
        if (airborne && entry.animManager.hasAnimation("Jump")) {
          entry.animManager.playAnimation("Jump", false);
        } else if (speed > 5 && entry.animManager.hasAnimation("Running")) {
          entry.animManager.playAnimation("Running", true);
        } else if (speed > 0.5 && entry.animManager.hasAnimation("Walking")) {
          entry.animManager.playAnimation("Walking", true);
        } else {
          entry.animManager.playAnimation("Idle", true);
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
    this.composer.render(delta);
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  private addLights() {
    // Bright ambient light for campus visibility
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    // Bright hemisphere light simulating sky
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8);
    this.scene.add(hemi);

    // Main directional sun light
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(50, 100, 50);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -80;
    sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80;
    sun.shadow.camera.bottom = -80;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 500;
    sun.shadow.bias = -0.0001;
    this.scene.add(sun);

    // Fill light from opposite direction
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-50, 50, -50);
    this.scene.add(fillLight);
  }

  // Procedural city block with road, sidewalks, benches, and simple buildings
  private buildCity() {
    this.cityGroup.clear();

    // Base ground
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x7fa66b, roughness: 0.9, metalness: 0.05 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.cityGroup.add(ground);

    // Road strip through center
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x2d2d30, roughness: 0.85, metalness: 0.05 });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_HALF * 2, 10), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.01;
    road.receiveShadow = true;
    this.cityGroup.add(road);

    // Sidewalks along road
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xb0b5b8, roughness: 0.7, metalness: 0.05 });
    const sidewalkWidth = 4;
    const sidewalkLen = WORLD_HALF * 2;
    const sidewalkL = new THREE.Mesh(new THREE.BoxGeometry(sidewalkLen, 0.3, sidewalkWidth), sidewalkMat);
    sidewalkL.position.set(0, 0.15, -7);
    sidewalkL.receiveShadow = true;
    const sidewalkR = sidewalkL.clone();
    sidewalkR.position.z = 7;
    this.cityGroup.add(sidewalkL, sidewalkR);

    // Road lane markings
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf5d142, emissive: 0x6a5a1a, emissiveIntensity: 0.6 });
    for (let i = -WORLD_HALF + 5; i < WORLD_HALF; i += 6) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(3, 0.05, 0.4), lineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(i, 0.03, 0);
      line.receiveShadow = false;
      this.cityGroup.add(line);
    }

    // Benches/chairs along sidewalks
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x5a3b26, roughness: 0.6, metalness: 0.1 });
    const benchLegMat = new THREE.MeshStandardMaterial({ color: 0x2d2d30, roughness: 0.4, metalness: 0.2 });
    for (let i = -WORLD_HALF + 10; i <= WORLD_HALF - 10; i += 15) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(3, 0.25, 0.8), benchMat);
      seat.position.set(i, 0.5, -7 - 0.4);
      const back = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 0.2), benchMat);
      back.position.set(i, 1, -7 - 1.0);
      const leg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 8), benchLegMat);
      leg1.position.set(i - 1.2, 0.3, -7 - 0.2);
      const leg2 = leg1.clone(); leg2.position.x = i + 1.2;
      [seat, back, leg1, leg2].forEach((m) => { m.castShadow = true; m.receiveShadow = true; });
      this.cityGroup.add(seat, back, leg1, leg2);

      const seat2 = seat.clone(); seat2.position.z = 7 + 0.4;
      const back2 = back.clone(); back2.position.z = 7 + 1.0;
      const leg3 = leg1.clone(); leg3.position.z = 7 + 0.2; leg3.position.x = i - 1.2;
      const leg4 = leg2.clone(); leg4.position.z = 7 + 0.2; leg4.position.x = i + 1.2;
      this.cityGroup.add(seat2, back2, leg3, leg4);
    }

    // Simple street lamps
    const lampPoleMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.4, roughness: 0.5 });
    const lampHeadMat = new THREE.MeshStandardMaterial({ color: 0xf2f2d0, emissive: 0xf2e6b1, emissiveIntensity: 1.5 });
    for (let i = -WORLD_HALF + 12; i <= WORLD_HALF - 12; i += 18) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 6, 10), lampPoleMat);
      pole.position.set(i, 3, -9.5);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 0.8), lampHeadMat);
      head.position.set(i, 6.3, -9.5);
      pole.castShadow = true; pole.receiveShadow = true;
      head.castShadow = true; head.receiveShadow = true;
      this.cityGroup.add(pole, head);

      const pole2 = pole.clone(); pole2.position.z = 9.5;
      const head2 = head.clone(); head2.position.z = 9.5;
      this.cityGroup.add(pole2, head2);
    }

    // Trees for atmosphere
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b3924, roughness: 0.8 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f6b34, roughness: 0.6 });
    for (let i = -WORLD_HALF + 8; i <= WORLD_HALF - 8; i += 16) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 4, 8), trunkMat);
      trunk.position.set(i, 2, -WORLD_HALF + 8);
      const canopy = new THREE.Mesh(new THREE.SphereGeometry(2.4, 10, 10), leafMat);
      canopy.position.set(i, 4.6, -WORLD_HALF + 8);
      trunk.castShadow = true; trunk.receiveShadow = true;
      canopy.castShadow = true; canopy.receiveShadow = true;
      this.cityGroup.add(trunk, canopy);

      const trunk2 = trunk.clone(); trunk2.position.z = WORLD_HALF - 8;
      const canopy2 = canopy.clone(); canopy2.position.z = WORLD_HALF - 8;
      this.cityGroup.add(trunk2, canopy2);
    }

    // Simple building blocks
    const buildingColors = [0xc1c7d0, 0xa6b1c0, 0xd8d2c4, 0xb0c4b1];
    for (let i = -WORLD_HALF + 12; i <= WORLD_HALF - 12; i += 20) {
      const color = buildingColors[Math.floor(Math.random() * buildingColors.length)];
      const height = 8 + Math.random() * 10;
      const bldgMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
      const bldg = new THREE.Mesh(new THREE.BoxGeometry(10, height, 12), bldgMat);
      bldg.position.set(i, height / 2, -WORLD_HALF + 20);
      bldg.castShadow = true; bldg.receiveShadow = true;
      this.cityGroup.add(bldg);

      const bldg2 = bldg.clone();
      bldg2.position.z = WORLD_HALF - 20;
      this.cityGroup.add(bldg2);
    }
  }

  private buildSky() {
    // Simple bright sky dome for campus environment
    const skyGeo = new THREE.SphereGeometry(300, 32, 32);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: new THREE.Color(0x0077ff) },      // bright blue
        bottomColor: { value: new THREE.Color(0xffffff) },   // white horizon
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition).y;
          vec3 skyColor = mix(bottomColor, topColor, max(h, 0.0));
          gl_FragColor = vec4(skyColor, 1.0);
        }
      `
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(sky);
  }

  private buildGun() {
    const gun = new THREE.Group();
    // Classic DOOM-inspired right-hand carry with reduced scale.
    const weapon = this.createShotgun(true, 0.9);
    weapon.position.set(0.46, -0.58, -1.12);
    weapon.rotation.set(-0.2, 0.28, -0.05);
    gun.add(weapon);
    this.camera.add(gun);
    this.gun = gun;
  }

  private createShotgun(firstPerson: boolean, scale: number) {
    const group = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, metalness: 0.65, roughness: 0.32 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.9, roughness: 0.18 });
    const polymer = new THREE.MeshStandardMaterial({ color: firstPerson ? 0x2c2f33 : 0x32363b, metalness: 0.05, roughness: 0.6 });
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x1f1f23, metalness: 0.08, roughness: 0.75 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xba3c1c, metalness: 0.2, roughness: 0.4 });

    // Receiver / body
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.44 * scale, 0.16 * scale, 0.78 * scale), polymer);
    receiver.position.set(0, -0.04 * scale, -0.25 * scale);

    // Stock + buttpad
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.28 * scale, 0.16 * scale, 0.5 * scale), polymer);
    stock.position.set(-0.12 * scale, -0.06 * scale, 0.34 * scale);
    stock.rotation.set(0.08, -0.08, 0.02);
    const butt = new THREE.Mesh(new THREE.BoxGeometry(0.3 * scale, 0.18 * scale, 0.08 * scale), gripMat);
    butt.position.set(-0.12 * scale, -0.07 * scale, 0.62 * scale);

    // Barrel and magazine tube
    const barrelLen = 1.12 * scale;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045 * scale, 0.045 * scale, barrelLen, 14), steel);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.05 * scale, -0.85 * scale);
    const mag = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * scale, 0.035 * scale, barrelLen * 0.82, 12), metal);
    mag.rotation.x = Math.PI / 2;
    mag.position.set(0, -0.02 * scale, -0.72 * scale);

    // Pump grip with ribs
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.32 * scale, 0.16 * scale, 0.32 * scale), gripMat);
    pump.position.set(0, -0.02 * scale, -0.62 * scale);
    const ribs: THREE.Mesh[] = [];
    for (let i = -2; i <= 2; i++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.34 * scale, 0.02 * scale, 0.025 * scale), metal);
      rib.position.set(0, 0.06 * scale, -0.62 * scale + i * 0.055 * scale);
      ribs.push(rib);
    }

    // Top rail and sights
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12 * scale, 0.03 * scale, 0.36 * scale), steel);
    rail.position.set(0, 0.08 * scale, -0.38 * scale);
    const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.03 * scale, 0.05 * scale, 0.05 * scale), steel);
    frontSight.position.set(0, 0.1 * scale, -0.98 * scale);
    const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.05 * scale, 0.05 * scale, 0.05 * scale), steel);
    rearSight.position.set(0, 0.09 * scale, -0.15 * scale);

    // Shell holder (side saddle)
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.2 * scale, 0.06 * scale, 0.12 * scale), polymer);
    saddle.position.set(0.14 * scale, 0.0, -0.18 * scale);
    const shells: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.018 * scale, 0.018 * scale, 0.06 * scale, 10), accent);
      shell.rotation.z = Math.PI / 2;
      shell.position.set(0.14 * scale, -0.015 * scale + i * 0.022 * scale, -0.23 * scale);
      shells.push(shell);
    }

    // Grip / trigger guard
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12 * scale, 0.22 * scale, 0.12 * scale), gripMat);
    grip.position.set(0.02 * scale, -0.18 * scale, 0.02 * scale);
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.08 * scale, 0.018 * scale, 6, 12, Math.PI), metal);
    guard.rotation.x = Math.PI / 2;
    guard.position.set(0.02 * scale, -0.1 * scale, -0.04 * scale);

    const parts = [receiver, stock, butt, barrel, mag, pump, rail, frontSight, rearSight, saddle, grip, guard, ...ribs, ...shells];
    parts.forEach((m) => {
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    });

    // Muzzle flash anchor at barrel tip
    const muzzle = new THREE.Mesh(new THREE.ConeGeometry(0.16 * scale, 0.32 * scale, 10), new THREE.MeshBasicMaterial({ color: 0xffc277 }));
    muzzle.rotation.x = Math.PI;
    muzzle.position.set(0, 0.05 * scale, -0.85 * scale - barrelLen * 0.5);
    muzzle.visible = firstPerson;
    group.add(muzzle);

    if (firstPerson) {
      const leftHand = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.16), new THREE.MeshStandardMaterial({ color: 0xdcc8b1, roughness: 0.6 }));
      leftHand.position.set(-0.16, -0.18, -0.52);
      leftHand.rotation.set(-0.35, 0.45, 0.4);
      const rightHand = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.16), new THREE.MeshStandardMaterial({ color: 0xdcc8b1, roughness: 0.6 }));
      rightHand.position.set(0.1, -0.2, 0.06);
      rightHand.rotation.set(-0.12, -0.12, -0.35);
      group.add(leftHand, rightHand);
      this.pumpHandle = pump;

      const flash = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.55, 10), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9 }));
      flash.rotation.x = Math.PI;
      flash.position.copy(muzzle.position).add(new THREE.Vector3(0, 0, -0.05));
      flash.visible = false;
      group.add(flash);
      this.muzzleFlash = flash;
    }

    return group;
  }

  private createPlayerMesh(): MeshEntry | null {
    if (this.baseModel && this.baseModelGltf) {
      const cloned = SkeletonUtils.clone(this.baseModel) as THREE.Group;
      cloned.scale.set(1.05, 1.05, 1.05);
      cloned.rotation.y = Math.PI; // face down -Z to match forward
      cloned.position.y = 0;
      const tintMats: THREE.MeshStandardMaterial[] = [];
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && mesh.material) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          mat.color.setHex(HUMAN_COLOR);
          mat.metalness = 0.35;
          mat.roughness = 0.42;
          mat.emissive.setHex(0x0f1a0f);
          mat.emissiveIntensity = 0.1;
          mat.needsUpdate = true;
          tintMats.push(mat);
        }
      });
      const weapon = this.createShotgun(false, 0.7);
      weapon.position.set(0.24, 0.9, 0.15);
      weapon.rotation.set(0.0, Math.PI * 1.02, 0); // flip to face forward
      weapon.castShadow = true;
      weapon.receiveShadow = true;
      cloned.add(weapon);
      cloned.userData.tintMats = tintMats;

      const animManager = new AnimationManager(this.baseModelGltf);
      if (animManager.hasAnimation("Idle")) {
        animManager.playAnimation("Idle", true);
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
    // Character model not ready; skip rendering placeholders.
    return null;
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
    const draco = new DRACOLoader();
    draco.setDecoderPath("/draco/");
    loader.setDRACOLoader(draco);
    loader.load(
      "/models/asian_male_animated.glb",
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
    const pumpBaseZ = -0.62;
    if (this.pumpPhase === 1) {
      this.pumpTime += delta;
      const t = Math.min(1, this.pumpTime / pumpBackDur);
      this.pumpHandle.position.z = pumpBaseZ - travel * t;
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
      this.pumpHandle.position.z = pumpBaseZ - travel * (1 - t);
      if (t >= 1) {
        this.pumpPhase = 0;
        this.pumpTime = 0;
        this.pumpHandle.position.z = pumpBaseZ;
      }
    }
  }

  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
  }
}


