// Turning Claude's output into a consistent Bible: sprite sanitising and reference checks.
import {
  ACTION_KEYS,
  SPRITE,
  isProp,
  type Bible,
  type BibleGen,
  type EntityGen,
  type Rule,
  type SpriteBatch,
  type TileGen,
} from "@dung/shared";

const SPRITE_CHARS = /^[0-9a-f.]$/;

/** Force a sprite to SPRITE x SPRITE with chars that index the palette. */
export function sanitizeSprite(rows: string[], paletteSize: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < SPRITE; y++) {
    const src = (rows[y] ?? "").toLowerCase();
    let row = "";
    for (let x = 0; x < SPRITE; x++) {
      const c = src[x] ?? ".";
      row += SPRITE_CHARS.test(c) && (c === "." || parseInt(c, 16) < paletteSize) ? c : ".";
    }
    out.push(row);
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function buildBible(gen: BibleGen): Bible {
  const palette = gen.palette.filter((c) => HEX.test(c)).slice(0, 16);
  while (palette.length < 4) palette.push(["#1a1c2c", "#5d275d", "#b13e53", "#f4f4f4"][palette.length]);
  const bible: Bible = {
    title: gen.title,
    setting: gen.setting,
    tone: gen.tone,
    goal: gen.goal,
    palette,
    playerLook: gen.playerLook,
    playerSprite: null,
    floorTile: gen.floorTile,
    tiles: {},
    entities: {},
    actions: dedupeActions(gen.actions),
    rules: [],
  };
  merge(bible, { tiles: gen.tiles, entities: gen.entities, rules: gen.rules });
  if (!bible.tiles[bible.floorTile]?.passable) {
    const floor = Object.values(bible.tiles).find((t) => t.passable);
    if (floor) bible.floorTile = floor.id;
    else {
      bible.tiles.floor = { id: "floor", name: "Пол", passable: true, props: ["stone", "hard"], description: "Ровный холодный камень.", look: "plain stone floor", sprite: null };
      bible.floorTile = "floor";
    }
  }
  return bible;
}

function dedupeActions(actions: BibleGen["actions"]) {
  const seen = new Set<string>();
  return actions.filter((a) => ACTION_KEYS.includes(a.key) && !seen.has(a.key) && seen.add(a.key));
}

/**
 * Add new types and rules. Existing ids win (a chunk can't redefine the world).
 * Rules with dangling references are dropped, bad effects are stripped.
 * Returns what was actually added.
 */
export function merge(
  bible: Bible,
  add: { tiles?: TileGen[]; entities?: EntityGen[]; rules?: Rule[] },
): { tiles: number; entities: number; rules: Rule[] } {
  let tiles = 0;
  let entities = 0;
  for (const t of add.tiles ?? []) {
    if (bible.tiles[t.id] || bible.entities[t.id]) continue;
    bible.tiles[t.id] = { ...t, props: t.props.filter(isProp), sprite: null };
    tiles++;
  }
  for (const e of add.entities ?? []) {
    if (bible.entities[e.id] || bible.tiles[e.id]) continue;
    bible.entities[e.id] = {
      ...e,
      solid: e.kind === "item" ? false : e.kind === "obstacle" ? true : e.solid,
      props: e.props.filter(isProp),
      sprite: null,
    };
    entities++;
  }
  const rules: Rule[] = [];
  for (const r of add.rules ?? []) {
    const clean = validateRule(bible, r);
    if (!clean) continue;
    let id = clean.id;
    for (let n = 2; bible.rules.some((x) => x.id === id); n++) id = `${clean.id}_${n}`;
    const rule = { ...clean, id };
    bible.rules.push(rule);
    rules.push(rule);
  }
  return { tiles, entities, rules };
}

export function validateRule(bible: Bible, r: Rule): Rule | null {
  const known = (id: string | null) => !!id && (!!bible.tiles[id] || !!bible.entities[id]);
  const isItem = (id: string | null) => !!id && bible.entities[id]?.kind === "item";
  // An unknown property would make the rule broader than intended: reject instead of dropping it.
  if (![...r.itemProps, ...r.targetProps].every(isProp)) return null;
  const target = known(r.target) ? r.target : null;
  if (!target && !r.targetProps.length) return null;
  const keys = new Set<string>(["SPACE", ...bible.actions.map((a) => a.key)]);
  if (r.trigger === "interact" && !(r.key && keys.has(r.key))) return null;
  const item = r.trigger === "use_item" && isItem(r.item) ? r.item : null;
  if (r.trigger === "use_item" && !item && !r.itemProps.length) return null;
  const effects = r.effects.filter((e) => {
    switch (e.type) {
      case "give_item":
      case "take_item":
        return isItem(e.item);
      case "replace_entity":
      case "spawn":
        return !!e.entity && !!bible.entities[e.entity];
      case "set_tile":
        return !!e.tile && !!bible.tiles[e.tile];
      case "set_flag":
        return !!e.flag;
      case "counter_add":
        return !!e.counter;
      case "message":
        return !!e.text;
      default:
        return true;
    }
  });
  const conditions = r.conditions.filter((c) =>
    c.type === "has_item" ? isItem(c.item) : c.type === "flag" ? !!c.flag : !!c.counter,
  );
  if (!effects.length) return null;
  return {
    ...r,
    key: r.trigger === "interact" ? r.key : null,
    item,
    itemProps: r.trigger === "use_item" ? [...new Set(r.itemProps)] : [],
    target,
    targetProps: [...new Set(r.targetProps)],
    effects,
    conditions,
  };
}

export type SpriteJob = { id: string; what: string; look: string };

/** Everything that still needs a sprite; "player" is the player character. */
export function missingSprites(bible: Bible): SpriteJob[] {
  const jobs: SpriteJob[] = [];
  if (!bible.playerSprite) jobs.push({ id: "player", what: "player character, facing right", look: bible.playerLook });
  for (const t of Object.values(bible.tiles))
    if (!t.sprite) jobs.push({ id: t.id, what: `${t.passable ? "floor" : "wall"} tile "${t.name}" (opaque, seamless)`, look: t.look });
  for (const e of Object.values(bible.entities))
    if (!e.sprite) jobs.push({ id: e.id, what: `${e.kind} "${e.name}" (centred, transparent margins)`, look: e.look });
  return jobs;
}

/** Store drawn sprites; returns how many were applied. */
export function applySprites(bible: Bible, batch: SpriteBatch): number {
  let n = 0;
  for (const { id, rows } of batch.sprites) {
    const sprite = sanitizeSprite(rows, bible.palette.length);
    if (id === "player") bible.playerSprite = sprite;
    else if (bible.tiles[id]) bible.tiles[id].sprite = sprite;
    else if (bible.entities[id]) bible.entities[id].sprite = sprite;
    else continue;
    n++;
  }
  return n;
}

/** Compact, sprite-free text view of the bible for prompts. */
export function digest(bible: Bible): string {
  const strip = (o: object) => JSON.stringify(o, (_k, v) => (v === null ? undefined : v));
  const lines = [
    `TITLE: ${bible.title}`,
    `SETTING: ${bible.setting}`,
    `TONE: ${bible.tone}`,
    `GOAL: ${bible.goal}`,
    `PALETTE (${bible.palette.length} colors, index: hex): ${bible.palette.map((c, i) => `${i.toString(16)}:${c}`).join(" ")}`,
    `FLOOR TILE: ${bible.floorTile}`,
    `ACTION KEYS: SPACE=interact, ${bible.actions.map((a) => `${a.key}=${a.verb}`).join(", ")}`,
    "TILES:",
    ...Object.values(bible.tiles).map((t) => `- ${t.id} "${t.name}" ${t.passable ? "passable" : "wall"} [${t.props.join(",")}]`),
    "ENTITIES:",
    ...Object.values(bible.entities).map(
      (e) => `- ${e.id} "${e.name}" ${e.kind}${e.solid ? " solid" : ""} [${e.props.join(",")}]`,
    ),
    "RULES:",
    ...bible.rules.map((r) => `- ${strip(r)}`),
  ];
  return lines.join("\n");
}
