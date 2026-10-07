// Parity: the WASM Engine must return the same result as native Rust
// for every committed vector. Run from repo root: node ./sdk/js/parity.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const { Engine } = await import(pathToFileURL(join(here, "pkg-nodejs", "switchyard_wasm.js")).href);

const vectors = join(root, "spec", "vectors");
const cases = JSON.parse(readFileSync(join(vectors, "evaluations.json"), "utf8"));

const engine = new Engine();
const version = engine.load(JSON.stringify(cases.config));
assert.equal(Number(version), cases.config.version, "load returns version");

let checked = 0;
for (const c of cases.cases) {
  const got = JSON.parse(engine.evaluate(c.flag, JSON.stringify(c.context)));
  assert.deepEqual(got, c.expected, `parity for flag=${c.flag} ctx=${JSON.stringify(c.context)}`);
  checked += 1;
}

// Malformed context never throws: ERROR with null value.
assert.deepEqual(JSON.parse(engine.evaluate("new-checkout", "not json")), {
  value: null, reason: "ERROR", ruleId: null,
});
// Invalid configs are rejected and the previous config stays active.
assert.throws(() => engine.load('{"version": 1, "flags": {}}'.replace('"flags": {}', '"flags": {"Bad Key!": {"type": "bool", "enabled": true, "offValue": "oops", "rules": [], "fallthrough": {"fixed": false}}}')));
assert.equal(Number(engine.version()), cases.config.version);

console.log(`parity OK: ${checked} evaluations identical to native`);
