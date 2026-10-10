// Zod schemas for everything Claude returns. They double as structured-output
// formats (zodOutputFormat) and as runtime validators.
// Keep them flat: nullable fields instead of unions, so the generated JSON Schema
// stays inside what structured outputs accept.
import { z } from "zod";

export const CHUNK = 16;
export const SPRITE = 16;
/** Situational keys Claude may bind. WASD/Space/Tab are fixed engine keys. */
export const ACTION_KEYS = ["E", "Q", "F", "R", "1", "2", "3", "4"] as const;
export const TRIGGER_KEYS = ["SPACE", ...ACTION_KEYS] as const;

/** 16 rows x 16 chars; each char is a palette index 0-9a-f, '.' = transparent. */
export const SpriteSchema = z.array(z.string()).describe(
  "Exactly 16 strings of exactly 16 chars. Each char is a hex palette index (0-9, a-f) or '.' for transparent.",
);

// Claude generates types without sprites (fast); sprites come later from separate batch calls.
export const TileDefSchema = z.object({
  id: z.string().describe("snake_case id, unique"),
  name: z.string(),
  passable: z.boolean(),
  look: z.string().describe("Short visual description for the pixel artist: colours, pattern"),
});

export const EntityDefSchema = z.object({
  id: z.string().describe("snake_case id, unique"),
  name: z.string(),
  kind: z.enum(["item", "obstacle", "feature"]).describe(
    "item: picked up into inventory when the player steps on it. obstacle: solid, blocks movement until a rule removes/replaces it. feature: anything else (signs, altars, NPC-like props); solid or not.",
  ),
  solid: z.boolean(),
  description: z.string().describe("One short sentence shown when examined."),
  look: z.string().describe("Short visual description for the pixel artist: shape, colours"),
});

export const ConditionSchema = z.object({
  type: z.enum(["has_item", "flag", "counter_cmp"]),
  item: z.string().nullable(),
  flag: z.string().nullable(),
  /** for flag: required value; ignored otherwise */
  value: z.boolean().nullable(),
  counter: z.string().nullable(),
  op: z.enum(["gte", "lte", "eq"]).nullable(),
  amount: z.number().nullable(),
});

export const EffectSchema = z.object({
  type: z.enum([
    "give_item",
    "take_item",
    "remove_entity",
    "replace_entity",
    "set_tile",
    "set_flag",
    "counter_add",
    "spawn",
    "teleport",
    "message",
  ]),
  /** give_item/take_item: item entity id */
  item: z.string().nullable(),
  /** replace_entity/spawn: entity type id */
  entity: z.string().nullable(),
  /** set_tile: tile id (applied at the target cell) */
  tile: z.string().nullable(),
  flag: z.string().nullable(),
  value: z.boolean().nullable(),
  counter: z.string().nullable(),
  /** give/take count, counter delta */
  amount: z.number().nullable(),
  text: z.string().nullable(),
  /** spawn: offset from target cell; teleport: offset from player */
  dx: z.number().nullable(),
  dy: z.number().nullable(),
});

export const RuleSchema = z.object({
  id: z.string(),
  trigger: z.enum(["interact", "step", "use_item"]).describe(
    "interact: player presses `key` while facing `target`. step: player walks onto `target`. use_item: player presses SPACE facing `target` with `item` selected.",
  ),
  key: z.enum(TRIGGER_KEYS).nullable().describe("interact only"),
  item: z.string().nullable().describe("use_item only: item entity id"),
  target: z.string().describe("entity type id or tile id"),
  label: z.string().describe("2-4 word verb phrase for the on-screen key hint, e.g. 'unlock door'"),
  conditions: z.array(ConditionSchema),
  effects: z.array(EffectSchema),
  /** shown when conditions fail; null = silent */
  failText: z.string().nullable(),
});

export const ActionBindingSchema = z.object({
  key: z.enum(ACTION_KEYS),
  verb: z.string().describe("Generic verb for this key in this world, e.g. 'pry', 'light', 'pray'"),
});

export const CounterInitSchema = z.object({ name: z.string(), value: z.number() });

export const BibleGenSchema = z.object({
  title: z.string(),
  setting: z.string().describe("2-3 sentences"),
  tone: z.string(),
  goal: z.string().describe("Loose, optional goal shown in the HUD"),
  palette: z.array(z.string()).describe("Up to 16 hex colors like '#1a1c2c'. Index 0 is darkest."),
  playerLook: z.string().describe("Short visual description of the player character"),
  floorTile: z.string().describe("id of the default passable ground tile"),
  tiles: z.array(TileDefSchema),
  entities: z.array(EntityDefSchema),
  actions: z.array(ActionBindingSchema).describe("2-4 situational keys"),
  counters: z.array(CounterInitSchema),
  rules: z.array(RuleSchema),
});

export const ChunkGenSchema = z.object({
  summary: z.string().describe("One sentence: what is in this area. Used as context for neighbours."),
  legend: z.array(z.object({ char: z.string(), tile: z.string() })),
  rows: z.array(z.string()).describe("Exactly 16 rows of exactly 16 legend chars"),
  entities: z.array(z.object({ type: z.string(), x: z.number(), y: z.number() })),
  newTiles: z.array(TileDefSchema),
  newEntities: z.array(EntityDefSchema),
  newRules: z.array(RuleSchema),
});

export const ImproviseSchema = z.object({
  message: z.string().describe("What the player sees happen, one sentence"),
  rule: RuleSchema.nullable().describe("Reusable rule for this situation, or null if nothing happens"),
  newEntities: z.array(EntityDefSchema),
  newTiles: z.array(TileDefSchema),
});

export const SpriteBatchSchema = z.object({
  sprites: z.array(z.object({ id: z.string(), rows: SpriteSchema })),
});

/** Runtime types carry the sprite once it has been drawn (null until then). */
export type TileGen = z.infer<typeof TileDefSchema>;
export type EntityGen = z.infer<typeof EntityDefSchema>;
export type TileDef = TileGen & { sprite: string[] | null };
export type EntityDef = EntityGen & { sprite: string[] | null };
export type SpriteBatch = z.infer<typeof SpriteBatchSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type ActionBinding = z.infer<typeof ActionBindingSchema>;
export type BibleGen = z.infer<typeof BibleGenSchema>;
export type ChunkGen = z.infer<typeof ChunkGenSchema>;
export type Improvise = z.infer<typeof ImproviseSchema>;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];
