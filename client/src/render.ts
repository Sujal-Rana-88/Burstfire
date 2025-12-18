import * as THREE from "three";
import { RemotePlayer } from "./net";

interface MeshEntry {
  mesh: THREE.Mesh;
}

export class Renderer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private playerMeshes: Map<number, MeshEntry> = new Map();
  private arenaSize = 28;
  private gun: THREE.Group | null = null;

  constructor() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x0a0f1a);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.6);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(5, 10, 2);
    this.scene.add(dir);

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(this.arenaSize, this.arenaSize, 1, 1),
      new THREE.MeshPhongMaterial({ color: 0x0f172a, side: THREE.DoubleSide })
    );
    plane.rotation.x = -Math.PI / 2;
    this.scene.add(plane);

    const grid = new THREE.GridHelper(this.arenaSize, 12, 0x3b82f6, 0x1f2937);
    this.scene.add(grid);

    // Simple bounding walls to visualize small map
    const wallMat = new THREE.MeshPhongMaterial({ color: 0x1f2937, opacity: 0.9, transparent: true });
    const wallThickness = 0.3;
    const wallHeight = 2.5;
    const wallLength = this.arenaSize;
    const wallGeomX = new THREE.BoxGeometry(wallLength, wallHeight, wallThickness);
    const wallGeomZ = new THREE.BoxGeometry(wallThickness, wallHeight, wallLength);
    const walls: THREE.Mesh[] = [
      new THREE.Mesh(wallGeomX, wallMat),
      new THREE.Mesh(wallGeomX, wallMat),
      new THREE.Mesh(wallGeomZ, wallMat),
      new THREE.Mesh(wallGeomZ, wallMat),
    ];
    walls[0].position.set(0, wallHeight / 2, wallLength / 2);
    walls[1].position.set(0, wallHeight / 2, -wallLength / 2);
    walls[2].position.set(wallLength / 2, wallHeight / 2, 0);
    walls[3].position.set(-wallLength / 2, wallHeight / 2, 0);
    walls.forEach((w) => this.scene.add(w));

    // Interior obstacles (must match server walls)
    const blocks: Array<[number, number, number, number]> = [
      [-3, 3, -1, 1],
      [-8, -4, 4, 8],
      [4, 8, -8, -4],
      [-10, -6, -8, -6],
      [6, 10, 6, 8],
    ];
    blocks.forEach(([minX, maxX, minZ, maxZ]) => {
      const w = maxX - minX;
      const d = maxZ - minZ;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, wallHeight, d),
        new THREE.MeshPhongMaterial({ color: 0x111827 })
      );
      mesh.position.set((minX + maxX) / 2, wallHeight / 2, (minZ + maxZ) / 2);
      this.scene.add(mesh);
    });

    this.buildGun();

    window.addEventListener("resize", () => this.onResize());
    this.onResize();
  }

  setCameraPose(x: number, y: number, z: number, yaw: number, pitch: number) {
    this.camera.position.set(x, y + 0.6, z);
    this.camera.rotation.set(pitch, yaw, 0, "YXZ");
  }

  updatePlayers(players: RemotePlayer[], localId: number | null) {
    const seen = new Set<number>();
    for (const p of players) {
      if (!p.active) continue;
      seen.add(p.id);
      if (p.id === localId) continue;
      let entry = this.playerMeshes.get(p.id);
      if (!entry) {
        const geom = new THREE.CapsuleGeometry(0.4, 1.0, 6, 12);
        const mat = new THREE.MeshStandardMaterial({ color: 0x93c5fd, metalness: 0.1, roughness: 0.6 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        this.scene.add(mesh);
        entry = { mesh };
        this.playerMeshes.set(p.id, entry);
      }
      const color = p.isBot ? 0xf59e0b : 0x93c5fd;
      (entry.mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
      entry.mesh.position.set(p.x, p.y, p.z);
      entry.mesh.rotation.y = p.yaw + Math.PI / 2;
    }

    // remove stale meshes
    for (const [id, entry] of this.playerMeshes.entries()) {
      if (!seen.has(id)) {
        this.scene.remove(entry.mesh);
        this.playerMeshes.delete(id);
      }
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setGunWeapon(weapon: number) {
    if (!this.gun) return;
    const colors = [0x6ee7b7, 0x93c5fd, 0xfcd34d, 0xf87171];
    this.gun.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) {
        const mat = (c as THREE.Mesh).material as THREE.MeshStandardMaterial;
        mat.color.setHex(colors[weapon % colors.length]);
      }
    });
  }

  private buildGun() {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x93c5fd, metalness: 0.3, roughness: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.18, 0.9), bodyMat);
    body.position.set(0, -0.05, -0.35);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.25, 0.12), new THREE.MeshStandardMaterial({ color: 0x111827 }));
    grip.position.set(-0.12, -0.2, -0.15);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8), new THREE.MeshStandardMaterial({ color: 0x4b5563, metalness: 0.6, roughness: 0.3 }));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0.12, 0, -0.25);
    group.add(body);
    group.add(grip);
    group.add(barrel);
    group.position.set(0.35, -0.25, -0.6);
    group.rotation.set(-0.05, 0.15, 0);
    this.camera.add(group);
    this.gun = group;
  }

  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
