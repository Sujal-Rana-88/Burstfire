import { InputController } from "./input";
import { NetClient, Snapshot } from "./net";
import { Predictor, Command } from "./predict";
import { Renderer } from "./render";

const renderer = new Renderer();
const input = new InputController(renderer.getCanvas());
const predictor = new Predictor();
const net = new NetClient(`ws://${location.hostname}:8080`);
const weaponNames = ["SMG", "Assault", "Shotgun", "Sniper"];

let playerId: number | null = null;
let lastSnap: Snapshot | null = null;

const overlay = document.getElementById("overlay")!;
const healthEl = document.getElementById("health")!;
const statusEl = document.getElementById("status")!;

overlay.addEventListener("click", () => {
  input.requestLock();
  overlay.style.display = "none";
});

document.addEventListener("pointerlockchange", () => {
  if (!input.isLocked()) {
    overlay.style.display = "flex";
  }
});

net.connect(
  (id) => {
    playerId = id;
    statusEl.textContent = `You are ${id}`;
  },
  (snap) => {
    lastSnap = snap;
    predictor.applySnapshot(snap, playerId);
  }
);

let accumulator = 0;
let lastTime = performance.now();
const FIXED = 1 / 60;

function loop(now: number) {
  const delta = (now - lastTime) / 1000;
  lastTime = now;
  accumulator += delta;

  while (accumulator >= FIXED) {
    const frameInput = input.poll();
    const seq = predictor.nextSeq();
    const cmd: Command = { seq, ...frameInput };
    net.sendInput(
      seq,
      frameInput.moveX,
      frameInput.moveZ,
      frameInput.yaw,
      frameInput.pitch,
      frameInput.fire,
      frameInput.weapon
    );
    predictor.enqueueAndPredict(cmd);
    accumulator -= FIXED;
  }

  const local = predictor.getLocalState();
  if (local) {
    renderer.setCameraPose(local.x, local.y, local.z, local.yaw, local.pitch);
    healthEl.textContent = `HP: ${predictor.getHealth()}`;
    const wName = weaponNames[local.weapon] ?? "Rifle";
    statusEl.textContent = `Weapon: ${wName} ${local.isBot ? "(bot)" : ""}`;
    renderer.setGunWeapon(local.weapon);
  }

  if (lastSnap) {
    renderer.updatePlayers(lastSnap.players, playerId);
  }

  renderer.render();
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
