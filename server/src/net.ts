import { WebSocketServer, WebSocket } from "ws";
import { gameBridge } from "./game";

interface ClientInfo {
  id: number;
  socket: WebSocket;
}

export class NetServer {
  private wss: WebSocketServer | null = null;
  private nextId = 1;
  private clients: Map<WebSocket, ClientInfo> = new Map();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  start(port: number) {
    if (this.wss) return;
    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", (ws) => this.handleConnection(ws));

    // Poll snapshots at 60 Hz and broadcast
    this.snapshotTimer = setInterval(() => {
      const snap = gameBridge.getSnapshot();
      if (!snap || snap.length === 0) return;
      for (const client of this.clients.values()) {
        if (client.socket.readyState === WebSocket.OPEN) {
          client.socket.send(snap);
        }
      }
    }, 1000 / 60);

    console.log(`[net] WebSocket server listening on :${port}`);
  }

  stop() {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = null;
    for (const client of this.clients.values()) {
      client.socket.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }

  private handleConnection(ws: WebSocket) {
    const id = this.nextId++;
    const info: ClientInfo = { id, socket: ws };
    this.clients.set(ws, info);

    // Handshake: small JSON for player id, not in hot path
    ws.send(JSON.stringify({ playerId: id }));

    ws.on("message", (data) => {
      if (!(data instanceof Buffer)) return;
      gameBridge.pushInput(id, data);
    });

    ws.on("close", () => {
      this.clients.delete(ws);
    });

    ws.on("error", (err) => {
      console.error("[net] client error", err);
      ws.close();
    });

    console.log(`[net] client connected ${id}`);
  }
}
