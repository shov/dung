// SPIKE: one improvisation call against the newest save. `npx tsx server/src/smoke-improvise.ts <item|-> <target>`
import { resolve } from "node:path";
import { ImproviseSchema } from "@dung/shared";
import { logMetric } from "./game.ts";
import { llm } from "./llm.ts";
import { improviseUser, worldSystem } from "./prompts.ts";
import { FileStore } from "./store.ts";

const store = new FileStore(resolve(import.meta.dirname, "../../saves-PROTOTYPE-wipe-me"));
const [save] = await store.list();
const { bible, player } = await store.load(save.id);
const item = process.argv[2] === "-" ? null : process.argv[2];
const res = await llm({ kind: "improvise", model: "sonnet", effort: "low", system: worldSystem(bible), user: improviseUser({ item, key: "SPACE", target: process.argv[3], player, journal: [] }), schema: ImproviseSchema });
logMetric(res.metric);
console.log(JSON.stringify(res.data, (_k, v) => (v === null ? undefined : v), 1));
