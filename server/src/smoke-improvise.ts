// SPIKE: one improvisation call. Uses a bible dump (from LLM_DUMP_DIR) or the newest save.
// `npx tsx --env-file=.env server/src/smoke-improvise.ts <item|-> <target> [bible-dump.json]`
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BibleGenSchema, ImproviseSchema, propsOf, type Bible } from "@dung/shared";
import { buildBible } from "./bible.ts";
import { logMetric } from "./game.ts";
import { llm } from "./llm.ts";
import { improviseUser, worldSystem } from "./prompts.ts";
import { FileStore } from "./store.ts";

const [itemArg, target, dump] = process.argv.slice(2);
let bible: Bible;
if (dump) bible = buildBible(BibleGenSchema.parse(JSON.parse(readFileSync(dump, "utf8")).res.structured_output));
else {
  const store = new FileStore(resolve(import.meta.dirname, "../../saves-PROTOTYPE-wipe-me"));
  bible = (await store.load((await store.list())[0].id)).bible;
}
const player = { x: 0, y: 0, facing: "down" as const, inventory: {}, selected: null, flags: {}, counters: {} };
const item = itemArg === "-" ? null : itemArg;
console.log("entities:", Object.values(bible.entities).map((e) => `${e.id}[${e.props}]`).join(" "));
const res = await llm({
  kind: "improvise", model: "sonnet", effort: "low", system: worldSystem(bible),
  user: improviseUser({ item, itemProps: propsOf(bible, item), key: item ? "SPACE" : "E", target, targetProps: propsOf(bible, target), player, journal: [] }),
  schema: ImproviseSchema,
});
logMetric(res.metric);
const r = res.data.rule;
console.log(res.data.message);
console.log(r ? `rule ${r.id}: ${r.trigger} ${r.item ?? `[${r.itemProps}]`} -> ${r.target ?? `[${r.targetProps}]`} => ${r.effects.map((e) => e.type + (e.entity ? ":" + e.entity : "")).join(",")}` : "rule: null");
