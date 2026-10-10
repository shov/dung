import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK, type Bible, type Chunk, type Improvise, type Rule, type ServerMsg } from "@dung/shared";
import { blankEffect } from "./engine.ts";
import type { SaveData, Store } from "./store.ts";

const llmMock = vi.hoisted(() => vi.fn());
vi.mock("./llm.ts", () => ({ llm: llmMock, LimitError: class extends Error {} }));
const { Game } = await import("./game.ts");

const base = { look: "", sprite: [] as string[], description: "d" };
function save(): SaveData {
  const bible: Bible = {
    title: "t", setting: "", tone: "", goal: "", palette: ["#000"], playerLook: "", playerSprite: [], floorTile: "floor",
    tiles: { floor: { ...base, id: "floor", name: "floor", passable: true, props: ["stone"] } },
    entities: {
      axe: { ...base, id: "axe", name: "Топор", kind: "item", solid: false, props: ["metal", "sharp", "hard"] },
      honey: { ...base, id: "honey", name: "Мёд", kind: "item", solid: false, props: ["sweet", "sticky"] },
      sign: { ...base, id: "sign", name: "Табличка", kind: "feature", solid: true, props: ["wood", "plant"] },
      bush: { ...base, id: "bush", name: "Куст", kind: "obstacle", solid: true, props: ["wood", "plant", "flexible"] },
    },
    actions: [],
    rules: [],
  };
  const tiles = Array(CHUNK * CHUNK).fill("floor");
  const chunks: Chunk[] = [];
  for (let cy = -1; cy <= 1; cy++)
    for (let cx = -1; cx <= 1; cx++) chunks.push({ cx, cy, tiles: [...tiles], entities: [], summary: "", source: "claude" });
  chunks[4].entities = [{ id: "s1", type: "sign", x: 8, y: 9 }, { id: "b1", type: "bush", x: 9, y: 8 }];
  return {
    bible,
    chunks,
    journal: [],
    player: { x: 8, y: 8, facing: "down", inventory: { axe: 1, honey: 1 }, selected: "axe", flags: {}, counters: {} },
  };
}

const memStore = (data: SaveData): Store => ({
  list: async () => [],
  load: async () => data,
  saveBible: async () => {},
  saveChunk: async () => {},
  savePlayer: async () => {},
  appendJournal: async () => {},
  appendMetric: async () => {},
});

const metric = { at: 0, kind: "improvise", model: "sonnet", ms: 1, ok: true, retries: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
const answer = (data: Partial<Improvise>) =>
  llmMock.mockResolvedValueOnce({ data: { message: "m", rule: null, newEntities: [], newTiles: [], ...data }, metric });
const chop: Rule = {
  id: "chop", trigger: "use_item", key: null, item: null, itemProps: ["sharp"], target: null, targetProps: ["wood"],
  conditions: [], effects: [{ ...blankEffect, type: "remove_entity" }], failText: null,
};

describe("improvisation", () => {
  let data: SaveData;
  let sent: ServerMsg[];
  let game: Awaited<ReturnType<typeof Game.load>>;
  beforeEach(async () => {
    llmMock.mockReset();
    data = save();
    sent = [];
    game = await Game.load(memStore(data), (m) => sent.push(m), "id");
  });

  it("learns a property rule, applies it, and reuses it without Claude", async () => {
    answer({ message: "Щепки!", rule: chop });
    await game.handleAction("SPACE"); // axe on sign
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(data.bible.rules.map((r) => r.id)).toEqual(["chop"]);
    expect(data.chunks[4].entities.map((e) => e.id)).toEqual(["b1"]);

    // the same rule covers the bush: no second Claude call
    await game.handleMove("right", 1);
    await game.handleAction("SPACE");
    expect(llmMock).toHaveBeenCalledTimes(1);
    expect(data.chunks[4].entities).toEqual([]);
  });

  it("narrows a rule that does not cover the situation to exact ids", async () => {
    answer({ rule: { ...chop, itemProps: ["glowing"] } }); // axe isn't glowing
    await game.handleAction("SPACE");
    expect(data.bible.rules).toHaveLength(1);
    expect(data.bible.rules[0]).toMatchObject({ item: "axe", itemProps: [], target: "sign", targetProps: [] });
  });

  it("remembers 'nothing happens' so Claude is asked once", async () => {
    data.player.selected = "honey";
    answer({ message: "Мёд стекает.", rule: null });
    await game.handleAction("SPACE");
    await game.handleAction("SPACE");
    expect(llmMock).toHaveBeenCalledTimes(1);
    const logs = sent.filter((m) => m.t === "log").map((m) => (m as { lines: string[] }).lines[0]);
    expect(logs).toEqual(["Мёд стекает.", "Мёд стекает."]);
  });
});
