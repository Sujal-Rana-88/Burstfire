export type WallRect = [number, number, number, number];

export interface PlatformRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  h: number; // top height in world units
}

// Simple city block bounds
export const WORLD_HALF = 50;
export const ARENA_SIZE = WORLD_HALF * 2;
export const PERIMETER_WALLS: WallRect[] = [
  [-WORLD_HALF, WORLD_HALF, WORLD_HALF - 1, WORLD_HALF],
  [-WORLD_HALF, WORLD_HALF, -WORLD_HALF, -WORLD_HALF + 1],
  [-WORLD_HALF, -WORLD_HALF + 1, -WORLD_HALF, WORLD_HALF],
  [WORLD_HALF - 1, WORLD_HALF, -WORLD_HALF, WORLD_HALF],
];

// No interior collision meshes; rely on perimeter only (matches PSU map visuals).
export const WALL_RECTS: WallRect[] = [];

export const PLATFORM_RECTS: PlatformRect[] = [];

export const ALL_WALLS: WallRect[] = [...PERIMETER_WALLS, ...WALL_RECTS];

export const SPAWN_POINTS: Array<[number, number]> = [
  [-5, -5],
  [5, -5],
  [-5, 5],
  [5, 5],
  [0, -6],
  [0, 6],
  [-8, 0],
  [8, 0],
];
