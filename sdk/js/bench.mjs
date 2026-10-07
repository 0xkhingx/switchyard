// Quick WASM throughput probe for README numbers. Run: node ./sdk/js/bench.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { Engine } = await import(pathToFileURL(join(here, "pkg-nodejs", "switchyard_wasm.js")).href);
const cases = JSON.parse(readFileSync(join(here, "..", "..", "spec", "vectors", "evaluations.json"), "utf8"));

const engine = new Engine();
engine.load(JSON.stringify(cases.config));
const ctx = JSON.stringify({ key: "user-4242", attributes: { country: "US", plan: "pro" } });
for (let i = 0; i < 1000; i++) engine.evaluate("new-checkout", ctx);

const n = 50_000;
const t0 = performance.now();
for (let i = 0; i < n; i++) engine.evaluate("new-checkout", ctx);
const ms = performance.now() - t0;
console.log(`wasm evaluate: ${(ms * 1e6 / n).toFixed(0)} ns/eval (${(1000 * n / ms).toFixed(0)} evals/sec)`);
