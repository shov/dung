import { describe, expect, it } from "vitest";
import { CHUNK, matchRules, type Bible, type Chunk, type Condition, type Prop, type Rule } from "@dung/shared";
import { blankEffect, checkCondition, interact, move, type GameState } from "./engine.ts";

const base = { look: "", sprite: null, description: "Описание." };
const tile = (id: string, passable: boolean, props: Prop[] = []) => ({ ...base, id, name: id, passable, props });
const ent = (id: string, kind: "item" | "obstacle" | "feature", solid: boolean, props: Prop[]) => ({
  ...base, id, name: id, kind, solid, props,
});
const cond = (c: Partial<Condition> & Pick<Condition, "type">): Condition => ({
  item: null, flag: null, value: null, counter: null, op: null, amount: null, ...c,
});
const fx = (e: Partial<typeof blankEffect> & Pick<typeof blankEffect, "type">) => ({ ...blankEffect, ...e });
const rule = (r: Partial<Rule> & Pick<Rule, "id" | "trigger" | "effects">): Rule => ({
  key: null, item: null, itemProps: [], target: null, targetProps: [], conditions: [], failText: null, ...r,
});

function state(rules: Rule[] = []): GameState {
  const bible: Bible = {
    title: "t", setting: "", tone: "", goal: "", palette: ["#000"], playerLook: "", playerSprite: null, floorTile: "floor",
    tiles: {
      floor: tile("floor", true, ["stone"]),
      wall: tile("wall", false, ["stone", "hard"]),
      water: tile("water", false, ["liquid", "wet"]),
    },
    entities: {
      key: ent("key", "item", false, ["metal", "hard"]),
      knife: ent("knife", "item", false, ["metal", "sharp", "hard", "conductive"]),
      stick: ent("stick", "item", false, ["wood", "long"]),
      door: ent("door", "obstacle", true, ["wood", "hard"]),
      open_door: ent("open_door", "feature", false, ["wood"]),
      bush: ent("bush", "obstacle", true, ["plant", "wood", "flexible"]),
      statue: ent("statue", "feature", true, ["stone"]),
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
      { id: "b1", type: "bush", x: 1, y: 0 },
    ],
  };
  return {
    bible,
    chunks: new Map([["0,0", chunk]]),
    player: { x: 1, y: 1, facing: "down", inventory: {}, selected: null, flags: {}, counters: { hp: 3 } },
  };
}

const cutPlants = rule({
  id: "cut", trigger: "use_item", itemProps: ["sharp"], targetProps: ["plant", "flexible"],
  effects: [fx({ type: "remove_entity" })],
});
const unlock = rule({
  id: "unlock", trigger: "use_item", item: "key", target: "door",
  effects: [fx({ type: "take_item", item: "key" }), fx({ type: "replace_entity", entity: "open_door" })],
});
const clearKey = (s: GameState) => {
  const c = s.chunks.get("0,0")!;
  c.entities = c.entities.filter((e) => e.id !== "k1");
};
const hold = (s: GameState, item: string) => {
  s.player.inventory[item] = 1;
  s.player.selected = item;
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

describe("property matching", () => {
  it("needs every listed property on item and target", () => {
    const s = state([cutPlants]);
    expect(matchRules(s.bible, "use_item", "bush", { item: "knife" }).map((r) => r.id)).toEqual(["cut"]);
    expect(matchRules(s.bible, "use_item", "bush", { item: "stick" })).toEqual([]);
    expect(matchRules(s.bible, "use_item", "door", { item: "knife" })).toEqual([]);
  });
  it("prefers exact-id rules over property rules", () => {
    const pry = rule({ id: "pry", trigger: "use_item", itemProps: ["metal"], targetProps: ["wood"], effects: [fx({ type: "message", text: "x" })] });
    const s = state([pry, unlock]);
    expect(matchRules(s.bible, "use_item", "door", { item: "key" }).map((r) => r.id)).toEqual(["unlock", "pry"]);
  });
  it("never matches a use_item rule without an item", () => {
    const s = state([cutPlants]);
    expect(matchRules(s.bible, "use_item", "bush", { item: null })).toEqual([]);
  });
});

describe("movement", () => {
  it("is blocked by solid entities but turns the player", () => {
    const s = state();
    const r = move(s, "left");
    expect(r.moved).toBe(false);
    expect(s.player).toMatchObject({ x: 1, y: 1, facing: "left" });
  });
  it("auto-picks up items on step and describes them", () => {
    const s = state();
    const r = move(s, "right");
    expect(r.moved).toBe(true);
    expect(s.player.inventory).toEqual({ key: 1 });
    expect(s.player.selected).toBe("key");
    expect(r.messages[0]).toContain("Описание.");
    expect(s.chunks.get("0,0")!.entities.some((e) => e.id === "k1")).toBe(false);
  });
  it("refuses to walk into an ungenerated chunk", () => {
    const s = state();
    s.player.y = 0;
    expect(move(s, "up").moved).toBe(false);
  });
});

describe("interact", () => {
  it("any sharp item clears any plant obstacle", () => {
    const s = state([cutPlants]);
    s.player.facing = "up";
    hold(s, "knife");
    expect(interact(s, "SPACE").firedRule).toBe("cut");
    expect(move(s, "up").moved).toBe(true);
  });
  it("asks Claude when an item has no rule for the target", () => {
    const s = state([cutPlants]);
    s.player.facing = "up";
    hold(s, "stick");
    expect(interact(s, "SPACE").improvise).toMatchObject({ item: "stick", target: { id: "bush" } });
  });
  it("examines with empty hands instead of improvising", () => {
    const s = state();
    s.player.facing = "left";
    const r = interact(s, "SPACE");
    expect(r.improvise).toBeUndefined();
    expect(r.messages).toEqual(["statue. Описание."]);
  });
  it("asks Claude for a world verb with no rule, but not on bare floor", () => {
    const s = state();
    s.player.facing = "left";
    expect(interact(s, "E").improvise).toMatchObject({ key: "E", item: null });
    clearKey(s);
    s.player.facing = "right";
    expect(interact(s, "E").improvise).toBeUndefined();
  });
  it("fires exact-id rules and applies effects in order", () => {
    const s = state([unlock]);
    hold(s, "key");
    expect(interact(s, "SPACE").firedRule).toBe("unlock");
    expect(s.player.inventory).toEqual({});
    expect(s.chunks.get("0,0")!.entities.find((e) => e.id === "d1")!.type).toBe("open_door");
    expect(move(s, "down").moved).toBe(true);
  });
  it("shows a neutral text when conditions fail", () => {
    const guarded = rule({ ...cutPlants, id: "guarded", conditions: [cond({ type: "flag", flag: "strong" })] });
    const s = state([guarded]);
    s.player.facing = "up";
    hold(s, "knife");
    expect(interact(s, "SPACE").messages).toEqual(["Ничего не происходит."]);
  });
  it("set_tile and counters act on the target cell and player", () => {
    const flood = rule({
      id: "flood", trigger: "use_item", itemProps: ["metal"], targetProps: ["stone"],
      effects: [fx({ type: "set_tile", tile: "water" }), fx({ type: "counter_add", counter: "hp", amount: -1 })],
    });
    const s = state([flood]);
    clearKey(s);
    s.player.facing = "right";
    hold(s, "knife");
    interact(s, "SPACE");
    expect(s.chunks.get("0,0")!.tiles[1 * CHUNK + 2]).toBe("water");
    expect(s.player.counters.hp).toBe(2);
  });
});
