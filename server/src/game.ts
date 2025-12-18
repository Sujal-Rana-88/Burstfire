import path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const addonPath = path.join(__dirname, "../addon/build/Release/addon.node");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const native: any = require(addonPath);

export interface GameConfig {
  maxPlayers: number;
  worldHalfExtent: number;
  botCount: number;
}

class GameBridge {
  private started = false;

  start(config: GameConfig) {
    if (this.started) return;
    native.startServer(config);
    this.started = true;
  }

  stop() {
    if (!this.started) return;
    native.stopServer();
    this.started = false;
  }

  pushInput(playerId: number, buffer: Buffer) {
    return native.pushInput(playerId, buffer);
  }

  getSnapshot(): Buffer {
    const buf: ArrayBuffer = native.getSnapshot();
    return Buffer.from(buf);
  }
}

export const gameBridge = new GameBridge();
