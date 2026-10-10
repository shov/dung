// Guarantees every chunk can be walked through: each side has an opening that lines
// up with an already generated neighbour, and all openings share one component.
// Solid entities are ignored on purpose: they are puzzles, not walls.
import { CHUNK } from "@dung/shared";

export type Side = "n" | "s" | "w" | "e";
/** Passability of the neighbour's cells that touch this chunk, ordered along the edge. */
export type NeighbourEdges = Partial<Record<Side, boolean[]>>;

const idx = (x: number, y: number) => y * CHUNK + x;
const MID = CHUNK >> 1;

/** Our own edge cell for side `side`, position `i` along it. */
function edgeCell(side: Side, i: number): [number, number] {
  switch (side) {
    case "n":
      return [i, 0];
    case "s":
      return [i, CHUNK - 1];
    case "w":
      return [0, i];
    case "e":
      return [CHUNK - 1, i];
  }
}

/**
 * Mutates `passable` (and reports carved cells) so the chunk is traversable.
 * Returns the indices of cells that had to be turned into floor.
 */
export function repairConnectivity(passable: boolean[], neighbours: NeighbourEdges): number[] {
  const carved: number[] = [];
  const open = (x: number, y: number) => {
    const i = idx(x, y);
    if (!passable[i]) {
      passable[i] = true;
      carved.push(i);
    }
  };

  const anchors: number[] = [];
  for (const side of ["n", "s", "w", "e"] as Side[]) {
    const edge = neighbours[side];
    if (edge) {
      // Cells where both sides are open are real connections.
      const links = edge.flatMap((p, i) => (p && passable[idx(...edgeCell(side, i))] ? [i] : []));
      if (links.length) links.forEach((i) => anchors.push(idx(...edgeCell(side, i))));
      else {
        const i = edge.findIndex(Boolean);
        const at = edgeCell(side, i >= 0 ? i : MID);
        open(...at);
        anchors.push(idx(...at));
      }
    } else {
      const own = Array.from({ length: CHUNK }, (_, i) => i).filter((i) => passable[idx(...edgeCell(side, i))]);
      const at = edgeCell(side, own.length ? own[own.length >> 1] : MID);
      open(...at);
      anchors.push(idx(...at));
    }
  }

  // Merge components: grow the first anchor's component and tunnel to any anchor outside it.
  for (;;) {
    const main = component(passable, anchors[0]);
    const stray = anchors.find((a) => !main.has(a));
    if (stray === undefined) break;
    for (const i of tunnel(main, stray)) open(i % CHUNK, Math.floor(i / CHUNK));
  }
  return carved;
}

function neighboursOf(i: number) {
  const x = i % CHUNK;
  const y = Math.floor(i / CHUNK);
  const out: number[] = [];
  if (x > 0) out.push(i - 1);
  if (x < CHUNK - 1) out.push(i + 1);
  if (y > 0) out.push(i - CHUNK);
  if (y < CHUNK - 1) out.push(i + CHUNK);
  return out;
}

function component(passable: boolean[], start: number) {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    for (const n of neighboursOf(queue.shift()!)) {
      if (passable[n] && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** Shortest grid path from `target` to any cell of `main`, ignoring walls. */
function tunnel(main: Set<number>, target: number) {
  const prev = new Map<number, number>([[target, -1]]);
  const queue = [target];
  while (queue.length) {
    const cur = queue.shift()!;
    if (main.has(cur)) {
      const path: number[] = [];
      for (let c = cur; c !== -1; c = prev.get(c)!) path.push(c);
      return path;
    }
    for (const n of neighboursOf(cur)) {
      if (!prev.has(n)) {
        prev.set(n, cur);
        queue.push(n);
      }
    }
  }
  return [target];
}
