export interface RemotePlayer {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  health: number;
  active: boolean;
  lastSeq: number;
  isBot: boolean;
  weapon: number;
}

export interface Snapshot {
  tick: number;
  players: RemotePlayer[];
}

type SnapshotHandler = (snap: Snapshot) => void;

type HandshakeHandler = (playerId: number) => void;

export class NetClient {
  private ws: WebSocket | null = null;
  private onSnapshot?: SnapshotHandler;
  private onHandshake?: HandshakeHandler;

  constructor(private url: string) {}

  connect(onHandshake: HandshakeHandler, onSnapshot: SnapshotHandler) {
    this.onHandshake = onHandshake;
    this.onSnapshot = onSnapshot;
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (evt) => this.handleMessage(evt.data);
    this.ws.onopen = () => console.log("[net] connected");
    this.ws.onclose = () => console.log("[net] closed");
    this.ws.onerror = (e) => console.error("[net] error", e);
  }

  sendInput(seq: number, moveX: number, moveZ: number, yaw: number, pitch: number, fire: boolean, weapon: number, jump: boolean) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const buf = new ArrayBuffer(23);
    const view = new DataView(buf);
    let offset = 0;
    view.setUint32(offset, seq, true);
    offset += 4;
    view.setFloat32(offset, moveX, true);
    offset += 4;
    view.setFloat32(offset, moveZ, true);
    offset += 4;
    view.setFloat32(offset, yaw, true);
    offset += 4;
    view.setFloat32(offset, pitch, true);
    offset += 4;
    view.setUint8(offset, fire ? 1 : 0);
    offset += 1;
    view.setUint8(offset, weapon);
    offset += 1;
    view.setUint8(offset, jump ? 1 : 0);
    this.ws.send(buf);
  }

  private handleMessage(data: string | ArrayBuffer) {
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (typeof msg.playerId === "number" && this.onHandshake) {
          this.onHandshake(msg.playerId);
        }
      } catch (err) {
        console.error("[net] bad JSON", err);
      }
      return;
    }

    if (data instanceof ArrayBuffer) {
      const snap = this.parseSnapshot(data);
      if (snap && this.onSnapshot) {
        this.onSnapshot(snap);
      }
    }
  }

  private parseSnapshot(buf: ArrayBuffer): Snapshot | null {
    const dv = new DataView(buf);
    if (dv.byteLength < 6) return null;
    let offset = 0;
    const tick = dv.getUint32(offset, true);
    offset += 4;
    const count = dv.getUint16(offset, true);
    offset += 2;
    const players: RemotePlayer[] = [];
    for (let i = 0; i < count; i++) {
      if (offset + 4 + 4 * 8 + 2 + 1 + 1 + 1 + 4 > dv.byteLength) break;
      const id = dv.getUint32(offset, true);
      offset += 4;
      const x = dv.getFloat32(offset, true);
      offset += 4;
      const y = dv.getFloat32(offset, true);
      offset += 4;
      const z = dv.getFloat32(offset, true);
      offset += 4;
      const vx = dv.getFloat32(offset, true);
      offset += 4;
      const vy = dv.getFloat32(offset, true);
      offset += 4;
      const vz = dv.getFloat32(offset, true);
      offset += 4;
      const yaw = dv.getFloat32(offset, true);
      offset += 4;
      const pitch = dv.getFloat32(offset, true);
      offset += 4;
      const health = dv.getInt16(offset, true);
      offset += 2;
      const active = dv.getUint8(offset) === 1;
      offset += 1;
      const isBot = dv.getUint8(offset) === 1;
      offset += 1;
      const weapon = dv.getUint8(offset);
      offset += 1;
      const lastSeq = dv.getUint32(offset, true);
      offset += 4;
      players.push({ id, x, y, z, vx, vy, vz, yaw, pitch, health, active, isBot, weapon, lastSeq });
    }

    return { tick, players };
  }
}
