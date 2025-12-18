import { gameBridge } from "./game";
import { NetServer } from "./net";

const port = Number(process.env.PORT || 8080);

gameBridge.start({ maxPlayers: 64, worldHalfExtent: 14, botCount: 0 });
const net = new NetServer();
net.start(port);

process.on("SIGINT", () => {
  console.log("Shutting down...");
  net.stop();
  gameBridge.stop();
  process.exit(0);
});
