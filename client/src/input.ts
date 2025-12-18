const SENSITIVITY = 0.0025;
const MAX_PITCH = 1.4;

export interface InputState {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  fire: boolean;
  weapon: number;
  jump: boolean;
}

export class InputController {
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private fireQueued = false;
  private locked = false;
  private weapon = 0;
  private jump = false;

  constructor(private element: HTMLElement) {
    this.bindEvents();
  }

  getYaw() {
    return this.yaw;
  }

  getPitch() {
    return this.pitch;
  }

  poll(): InputState {
    const moveX = (this.keys.has("d") ? 1 : 0) + (this.keys.has("a") ? -1 : 0);
    const moveZ = (this.keys.has("w") ? 1 : 0) + (this.keys.has("s") ? -1 : 0);
    const fire = this.fireQueued;
    this.fireQueued = false;
    return { moveX, moveZ, yaw: this.yaw, pitch: this.pitch, fire, weapon: this.weapon, jump: this.jump };
  }

  requestLock() {
    this.element.requestPointerLock();
  }

  isLocked() {
    return this.locked;
  }

  private bindEvents() {
    window.addEventListener("keydown", (e) => {
      const key = e.key.toLowerCase();
      if (["w", "a", "s", "d"].includes(key)) {
        this.keys.add(key);
      }
      if (key === " " || key === "space") {
        this.jump = true;
      }
    });
    window.addEventListener("keyup", (e) => {
      const key = e.key.toLowerCase();
      if (["w", "a", "s", "d"].includes(key)) {
        this.keys.delete(key);
      }
      if (key === " " || key === "space") {
        this.jump = false;
      }
    });
    window.addEventListener("mousedown", () => {
      this.fireQueued = true;
    });
    window.addEventListener("pointerdown", (e) => {
      if (e.button === 0) this.fireQueued = true;
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.element;
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * SENSITIVITY;
      this.pitch -= e.movementY * SENSITIVITY;
      if (this.pitch > MAX_PITCH) this.pitch = MAX_PITCH;
      if (this.pitch < -MAX_PITCH) this.pitch = -MAX_PITCH;
    });
  }
}
