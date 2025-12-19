import { RemotePlayer, Snapshot } from "./net";
import { ALL_WALLS, PLATFORM_RECTS, WORLD_HALF } from "./map";

export interface Command {
  seq: number;
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  fire: boolean;
  weapon: number;
  jump: boolean;
}

export interface PlayerState extends RemotePlayer {}

const FIXED_DT = 1 / 60;
const MAX_SPEED = 12;
const ACCEL = 50;
const FRICTION = 8;
const PLAYER_RADIUS = 0.35;
const GRAVITY = 26;
const JUMP_VEL = 11;
const GROUND_Y = 1.2; // Match server ground so we don't drift below the PSU floor
const WALLS: Array<[number, number, number, number]> = ALL_WALLS;
const PLATFORMS: Array<[number, number, number, number, number]> = PLATFORM_RECTS.map((p) => [p.minX, p.maxX, p.minZ, p.maxZ, p.h]);

export class Predictor {
  private seq = 1;
  private pending: Command[] = [];
  private localState: PlayerState | null = null;
  private lastHealth = 100;

  nextSeq() {
    return this.seq++;
  }

  getLocalState() {
    return this.localState;
  }

  getHealth() {
    return this.lastHealth;
  }

  enqueueAndPredict(cmd: Command) {
    if (!this.localState) return;
    this.pending.push(cmd);
    this.applyCommand(this.localState, cmd, FIXED_DT);
  }

  applySnapshot(snap: Snapshot, playerId: number | null) {
    const me = snap.players.find((p) => p.id === playerId);
    if (me) {
      this.localState = { ...me };
      this.lastHealth = me.health;
      const ack = me.lastSeq;
      this.pending = this.pending.filter((p) => p.seq > ack);
      // Reapply pending inputs for smooth prediction
      for (const cmd of this.pending) {
        this.applyCommand(this.localState, cmd, FIXED_DT);
      }
    }
  }

  private applyCommand(state: PlayerState, cmd: Command, dt: number) {
    // match server integrate logic
    // yaw = 0 looks down -Z (Three.js default)
    const forwardX = -Math.sin(cmd.yaw);
    const forwardZ = -Math.cos(cmd.yaw);
    const rightX = Math.cos(cmd.yaw);
    const rightZ = -Math.sin(cmd.yaw);
    let moveDirX = forwardX * cmd.moveZ + rightX * cmd.moveX;
    let moveDirZ = forwardZ * cmd.moveZ + rightZ * cmd.moveX;
    const len = Math.hypot(moveDirX, moveDirZ);
    if (len > 1e-4) {
      moveDirX /= len;
      moveDirZ /= len;
    }
    state.vx += moveDirX * ACCEL * dt;
    state.vz += moveDirZ * ACCEL * dt;

    const speed = Math.hypot(state.vx, state.vz);
    if (speed > 0) {
      const drop = speed * FRICTION * dt;
      const newSpeed = Math.max(0, speed - drop);
      if (newSpeed !== speed) {
        const scale = newSpeed / speed;
        state.vx *= scale;
        state.vz *= scale;
      }
    }

    const newSpeed2 = Math.hypot(state.vx, state.vz);
    if (newSpeed2 > MAX_SPEED) {
      const scale = MAX_SPEED / newSpeed2;
      state.vx *= scale;
      state.vz *= scale;
    }

    state.x += state.vx * dt;
    state.z += state.vz * dt;

    let onGround = state.y <= GROUND_Y + 0.05;
    if (cmd.jump && onGround) {
      state.vy = JUMP_VEL;
      onGround = false;
    }
    state.vy -= GRAVITY * dt;
    state.y += state.vy * dt;
    if (state.y < GROUND_Y) {
      state.y = GROUND_Y;
      state.vy = 0;
      onGround = true;
    }

    this.resolveWalls(state);
    this.resolvePlatforms(state);

    state.x = Math.min(WORLD_HALF, Math.max(-WORLD_HALF, state.x));
    state.z = Math.min(WORLD_HALF, Math.max(-WORLD_HALF, state.z));

    state.yaw = cmd.yaw;
    state.pitch = cmd.pitch;
    state.weapon = 0;
  }

  private resolveWalls(p: PlayerState) {
    for (const [minX, maxX, minZ, maxZ] of WALLS) {
      if (!(p.x + PLAYER_RADIUS > minX && p.x - PLAYER_RADIUS < maxX && p.z + PLAYER_RADIUS > minZ && p.z - PLAYER_RADIUS < maxZ)) {
        continue;
      }
      const penLeft = maxX - (p.x - PLAYER_RADIUS);
      const penRight = (p.x + PLAYER_RADIUS) - minX;
      const penDown = (p.z + PLAYER_RADIUS) - minZ;
      const penUp = maxZ - (p.z - PLAYER_RADIUS);
      let minPen = penLeft;
      let axis = 0;
      if (penRight < minPen) { minPen = penRight; axis = 1; }
      if (penDown < minPen) { minPen = penDown; axis = 2; }
      if (penUp < minPen) { minPen = penUp; axis = 3; }
      switch (axis) {
        case 0: p.x = maxX + PLAYER_RADIUS; p.vx = 0; break;
        case 1: p.x = minX - PLAYER_RADIUS; p.vx = 0; break;
        case 2: p.z = minZ - PLAYER_RADIUS; p.vz = 0; break;
        case 3: p.z = maxZ + PLAYER_RADIUS; p.vz = 0; break;
      }
    }
  }

  private resolvePlatforms(p: PlayerState) {
    for (const [minX, maxX, minZ, maxZ, height] of PLATFORMS) {
      const insideXZ = p.x + PLAYER_RADIUS > minX && p.x - PLAYER_RADIUS < maxX && p.z + PLAYER_RADIUS > minZ && p.z - PLAYER_RADIUS < maxZ;
      if (!insideXZ) continue;
      const top = height;
      if (p.vy < 0 && p.y <= top + 0.2 && p.y >= top - 0.8) {
        p.y = top;
        p.vy = 0;
      }
      if (p.y > top + 0.2) continue;
      const penLeft = maxX - (p.x - PLAYER_RADIUS);
      const penRight = (p.x + PLAYER_RADIUS) - minX;
      const penDown = (p.z + PLAYER_RADIUS) - minZ;
      const penUp = maxZ - (p.z - PLAYER_RADIUS);
      let minPen = penLeft;
      let axis = 0;
      if (penRight < minPen) { minPen = penRight; axis = 1; }
      if (penDown < minPen) { minPen = penDown; axis = 2; }
      if (penUp < minPen) { minPen = penUp; axis = 3; }
      switch (axis) {
        case 0: p.x = maxX + PLAYER_RADIUS; p.vx = 0; break;
        case 1: p.x = minX - PLAYER_RADIUS; p.vx = 0; break;
        case 2: p.z = minZ - PLAYER_RADIUS; p.vz = 0; break;
        case 3: p.z = maxZ + PLAYER_RADIUS; p.vz = 0; break;
      }
    }
  }
}
