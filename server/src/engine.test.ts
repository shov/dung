import { describe, expect, it } from "vitest";
import { CHUNK, type Bible, type Chunk, type Condition, type Rule } from "@dung/shared";
import { blankEffect, checkCondition, interact, move, type GameState } from "./engine.ts";

const sprite = null;
const look = "";
const cond = (c: Partial<Condition> & Pick<Condition, "type">): Condition => ({
  item: null, flag: null, value: null, counter: null, op: null, amount: null, ...c,
});
const fx = (e: Partial<typeof blankEffect> & Pick<typeof blankEffect, "type">) => ({ ...blankEffect, ...e });

function state(rules: Rule[] = []): GameState {
  const bible: Bible = {
    title: "t", setting: "", tone: "", goal: "", palette: ["#000"], playerLook: look, playerSprite: sprite, floorTile: "floor",
    tiles: {
      floor: { id: "floor", name: "floor", passable: true, look, sprite },
      wall: { id: "wall", name: "wall", passable: false, look, sprite },
      gold_floor: { id: "gold_floor", name: "gold", passable: true, look, sprite },
    },
    entities: {
      key: { id: "key", name: "Ключ", kind: "item", solid: false, description: "", look, sprite },
      door: { id: "door", name: "Дверь", kind: "obstacle", solid: true, description: "Дверь.", look, sprite },
      open_door: { id: "open_door", name: "Открытая дверь", kind: "feature", solid: false, description: "", look, sprite },
      statue: { id: "statue", name: "Статуя", kind: "feature", solid: true, description: "Статуя.", look, sprite },
    },
    actions: [{ key: "E", verb: "pry" }],
    rules,
  };
  const chunk: Chunk = {
    cx: 0, cy: 0, summary: "", source: "claude",
    tiles: Array(CHUNK * CHUNK).fill("floor"),
    entities: [
      { id: "k1", type: "key", x: 2, y: 1 },
      { id: "d1", type: "door", x: 1, y: 2 },
      { id: "s1", type: "statue", x: 0, y: 1 },
    ],
  };
  return {
    bible,
    chunks: new Map([["0,0", chunk]]),
    player: { x: 1, y: 1, facing: "down", inventory: {}, selected: null, flags: {}, counters: { hp: 3 } },
  };
}

const unlock: Rule = {
  id: "unlock", trigger: "interact", key: "SPACE", item: null, target: "door", label: "открыть",
  conditions: [cond({ type: "has_item", item: "key" })],
  effects: [fx({ type: "take_item", item: "key" }), fx({ type: "replace_entity", entity: "open_door" })],
  failText: "Заперто.",
};

describe("conditions", () => {
  it("compares counters", () => {
    const p = state().player;
    expect(checkCondition(p, cond({ type: "counter_cmp", counter: "hp", op: "gte", amount: 3 }))).toBe(true);
    expect(checkCondition(p, cond({ type: "counter_cmp", counter: "hp", op: "lte", amount: 2 }))).toBe(false);
    expect(checkCondition(p, cond({ type: "counter_cmp", counter: "missing", op: "eq", amount: 0 }))).toBe(true);
  });
  it("checks flags with default true", () => {
    const p = state().player;
    expect(checkCondition(p, cond({ type: "flag", flag: "lit" }))).toBe(false);
    expect(checkCondition(p, cond({ type: "flag", flag: "lit", value: false }))).toBe(true);
  });
});

describe("movement", () => {
  it("is blocked by solid entities but turns the player", () => {
    const s = state();
    const r = move(s, "left");
    expect(r.moved).toBe(false);
    expect(s.player).toMatchObject({ x: 1, y: 1, facing: "left" });
  });
  it("auto-picks up items on step", () => {
    const s = state();
    const r = move(s, "right");
    expect(r.moved).toBe(true);
    expect(s.player.inventory).toEqual({ key: 1 });
    expect(s.player.selected).toBe("key");
    expect(s.chunks.get("0,0")!.entities.some((e) => e.id === "k1")).toBe(false);
  });
  it("refuses to walk into an ungenerated chunk", () => {
    const s = state();
    s.player.y = 0;
    expect(move(s, "up").moved).toBe(false);
  });
});

describe("interact", () => {
  it("shows failText when conditions fail", () => {
    const s = state([unlock]);
    expect(interact(s, "SPACE").messages).toEqual(["Заперто."]);
  });
  it("fires the rule and applies effects in order", () => {
    const s = state([unlock]);
    s.player.inventory.key = 1;
    s.player.selected = "key";
    // selected item but no use_item rule on the door -> improvise, not the interact rule
    expect(interact(s, "SPACE").improvise?.item).toBe("key");
    s.player.selected = null;
    const r = interact(s, "SPACE");
    expect(r.firedRule).toBe("unlock");
    expect(s.player.inventory).toEqual({});
    expect(s.chunks.get("0,0")!.entities.find((e) => e.id === "d1")!.type).toBe("open_door");
    expect(move(s, "down").moved).toBe(true);
  });
  it("asks for improvisation on an entity with no rules", () => {
    const s = state();
    s.player.facing = "left";
    const r = interact(s, "SPACE");
    expect(r.improvise).toMatchObject({ item: null, target: { id: "statue", entityId: "s1" } });
  });
  it("runs use_item rules and set_tile on the target cell", () => {
    const rule: Rule = {
      id: "gild", trigger: "use_item", key: null, item: "key", target: "floor", label: "позолотить",
      conditions: [], effects: [fx({ type: "set_tile", tile: "gold_floor" }), fx({ type: "counter_add", counter: "hp", amount: -1 })],
      failText: null,
    };
    const s = state([rule]);
    s.player.facing = "up";
    s.player.inventory.key = 1;
    s.player.selected = "key";
    interact(s, "SPACE");
    expect(s.chunks.get("0,0")!.tiles[0 * CHUNK + 1]).toBe("gold_floor");
    expect(s.player.counters.hp).toBe(2);
  });
});
