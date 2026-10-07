// Engine smoke check. Run from repo root: node ./sdk/js/spike.mjs
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const found = join(here, "pkg-nodejs", "switchyard_wasm.js");
if (!existsSync(found)) {
  console.error("nodejs wasm pkg not found. Build it first.");
  process.exit(1);
}
const { Engine } = await import(pathToFileURL(found).href);
const engine = new Engine();
const version = engine.load(JSON.stringify({
  version: 7,
  flags: {
    "new-checkout": {
      type: "bool", enabled: true, offValue: false, rules: [],
      fallthrough: { fixed: false },
    },
  },
}));
console.log("loaded version", Number(version));
console.log(engine.evaluate("new-checkout", JSON.stringify({ key: "u-1", attributes: {} })));
