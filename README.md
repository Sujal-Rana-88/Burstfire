# Burstfire

Lightweight multiplayer FPS prototype with server-authoritative C++ (N-API), Node.js networking, and a Vite/TypeScript/WebGL client. Features: WASD + mouselook, hitscan weapons, client prediction/reconciliation, hard-wall arena, and first-person gun model.

## Tech
- Backend: Node.js (TS) + N-API addon (C++17, 60 Hz tick, physics, hitscan)
- Frontend: Vite + TypeScript + Three.js renderer
- Networking: WebSocket binary packets (no JSON in hot paths)

## Setup
Prereqs: Node 22.x, Python 3, and C++ build tools/Windows SDK (for node-gyp on Windows).

### Server
```bash
cd server
npm install
npm run build      # builds addon + TS
npm start          # runs on :8080 (set PORT to change)
```

### Client
```bash
cd client
npm install
npm run dev        # opens at http://localhost:5173
```
Open two browser tabs to test multiplayer.

## Controls
- Move: W/A/S/D (strafe relative to view)
- Look: Mouse (pointer lock)
- Fire: Left click or space
- Weapons: 1=SMG, 2=Assault, 3=Shotgun, 4=Sniper (infinite ammo)

## Gameplay Notes
- Server simulates movement, collisions against hard walls, hitscan, health, and respawn.
- Client predicts locally and reconciles with snapshot acks; renders other players as capsules; shows your gun in first-person.
- Map: Expanded DOOM-style arena (56x56 units) with multiple rooms, corridors, Swordigo-inspired 3D aesthetics, dynamic lighting, and a realistic starry sky visible from above.

## Rebuilding Native Addon
If you change C++ code:
```bash
cd server
npx node-gyp clean --directory addon
npm run build
```

## Native Addon Layout
- `addon/game_server.cc` core server lifecycle, tick loop, snapshots.
- `addon/game_server_players.cc` player input, movement integration, respawn, hitscan damage.
- `addon/game_server_world.cc` static map setup plus wall/platform collision handling.
- `addon/game_server_ai.cc` bot behavior and spider AI/collision helpers.
- `addon/game_math.h`, `addon/weapon_defs.h` small shared helpers/constants.

## Binary Protocols
- Input to server (22 bytes): `u32 seq | f32 moveX | f32 moveZ | f32 yaw | f32 pitch | u8 fire | u8 weapon`
- Snapshot from server: `u32 tick | u16 count | per-player { u32 id, f32 x,y,z, f32 vx,vy,vz, f32 yaw, pitch, i16 health, u8 active, u8 isBot, u8 weapon, u32 lastSeq }`

## Project Structure
- `server/` Node.js + addon (physics/tick)
- `client/` Vite/TS/WebGL client
- `.vscode/` Dev settings

## Naming
Working title: **Burstfire**. Change freely.
