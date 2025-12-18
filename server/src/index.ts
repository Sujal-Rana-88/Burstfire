import { gameBridge } from "./game";
import { NetServer } from "./net";

const port = Number(process.env.PORT || 8080);

// DOOM-like arena footprint.
gameBridge.start({ maxPlayers: 64, worldHalfExtent: 24, botCount: 0 });
const net = new NetServer();
net.start(port);

process.on("SIGINT", () => {
  console.log("Shutting down...");
  net.stop();
  gameBridge.stop();
  process.exit(0);
});
