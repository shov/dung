import { describe, expect, it } from "vitest";
import { CHUNK } from "@dung/shared";
import { repairConnectivity } from "./connectivity.ts";

const grid = (rows: string[]) => rows.join("").split("").map((c) => c === ".");
const all = (v: boolean) => Array(CHUNK * CHUNK).fill(v) as boolean[];

function reachableAll(passable: boolean[], cells: number[]) {
  const seen = new Set([cells[0]]);
  const q = [cells[0]];
  while (q.length) {
    const i = q.shift()!;
    const x = i % CHUNK;
    for (const n of [x > 0 ? i - 1 : -1, x < CHUNK - 1 ? i + 1 : -1, i - CHUNK, i + CHUNK]) {
      if (n >= 0 && n < passable.length && passable[n] && !seen.has(n)) {
        seen.add(n);
        q.push(n);
      }
    }
  }
  return cells.every((c) => seen.has(c));
}

describe("repairConnectivity", () => {
  it("leaves an open chunk untouched", () => {
    const p = all(true);
    expect(repairConnectivity(p, {})).toEqual([]);
  });

  it("opens every side of a solid chunk and joins the openings", () => {
    const p = all(false);
    const carved = repairConnectivity(p, {});
    const mid = CHUNK >> 1;
    const openings = [mid, (CHUNK - 1) * CHUNK + mid, mid * CHUNK, mid * CHUNK + CHUNK - 1];
    expect(carved.length).toBeGreaterThan(0);
    expect(openings.every((i) => p[i])).toBe(true);
    expect(reachableAll(p, openings)).toBe(true);
  });

  it("joins two rooms split by a wall", () => {
    const rows = Array.from({ length: CHUNK }, () => ".......#........");
    const p = grid(rows);
    const carved = repairConnectivity(p, {});
    expect(carved).toHaveLength(1);
    expect(reachableAll(p, [0, CHUNK - 1])).toBe(true);
  });

  it("opens a cell facing the neighbour's only opening", () => {
    const p = all(true);
    for (let x = 0; x < CHUNK; x++) p[x] = false; // north row walled
    const north = Array(CHUNK).fill(false) as boolean[];
    north[3] = true;
    repairConnectivity(p, { n: north });
    expect(p[3]).toBe(true);
    expect(p.slice(0, CHUNK).filter(Boolean)).toHaveLength(1);
  });

  it("keeps existing links with a neighbour without carving", () => {
    const p = all(true);
    const north = Array(CHUNK).fill(true) as boolean[];
    expect(repairConnectivity(p, { n: north })).toEqual([]);
  });
});
