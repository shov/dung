// Runtime world state shared by server and client.
import { CHUNK, type ActionBinding, type EntityDef, type Rule, type TileDef } from "./schemas.ts";

export type Bible = {
  title: string;
  setting: string;
  tone: string;
  goal: string;
  palette: string[];
  playerLook: string;
  playerSprite: string[] | null;
  floorTile: string;
  tiles: Record<string, TileDef>;
  entities: Record<string, EntityDef>;
  actions: ActionBinding[];
  rules: Rule[];
};

export type EntityInst = { id: string; type: string; x: number; y: number };

export type Chunk = {
  cx: number;
  cy: number;
  /** CHUNK*CHUNK tile ids, row-major */
  tiles: string[];
  entities: EntityInst[];
  summary: string;
  source: "claude" | "fallback";
};

export type Dir = "up" | "down" | "left" | "right";

export type Player = {
  x: number;
  y: number;
  facing: Dir;
  inventory: Record<string, number>;
  selected: string | null;
  flags: Record<string, boolean>;
  counters: Record<string, number>;
};

export const DIRS: Record<Dir, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export const chunkKey = (cx: number, cy: number) => `${cx},${cy}`;
export const chunkOf = (x: number, y: number) => [Math.floor(x / CHUNK), Math.floor(y / CHUNK)] as const;
export const localOf = (x: number, y: number) => [((x % CHUNK) + CHUNK) % CHUNK, ((y % CHUNK) + CHUNK) % CHUNK] as const;

/** Read-only view over loaded chunks, used for movement checks on both sides. */
export function cellAt(chunks: Map<string, Chunk>, x: number, y: number) {
  const [cx, cy] = chunkOf(x, y);
  const chunk = chunks.get(chunkKey(cx, cy));
  if (!chunk) return null;
  const [lx, ly] = localOf(x, y);
  const entities = chunk.entities.filter((e) => e.x === lx && e.y === ly);
  return { chunk, lx, ly, tile: chunk.tiles[ly * CHUNK + lx], entities };
}

export function isWalkable(bible: Bible, chunks: Map<string, Chunk>, x: number, y: number) {
  const cell = cellAt(chunks, x, y);
  if (!cell) return false;
  if (!bible.tiles[cell.tile]?.passable) return false;
  return !cell.entities.some((e) => bible.entities[e.type]?.solid);
}

/** Rules that could fire for a target with the given trigger shape (conditions not checked). */
export function matchRules(bible: Bible, trigger: Rule["trigger"], target: string, opts: { key?: string; item?: string | null } = {}) {
  return bible.rules.filter(
    (r) =>
      r.trigger === trigger &&
      r.target === target &&
      (trigger !== "interact" || r.key === opts.key) &&
      (trigger !== "use_item" || r.item === opts.item),
  );
}
