// M0 spike loader: reads the nodejs wasm-pack output and calls evaluate().
// Run from repo root: node ./sdk/js/spike.mjs
// Build with (out-dir is relative to the crate dir):
//   wasm-pack build crates/switchyard-wasm --target nodejs --out-dir ../../sdk/js/pkg-nodejs
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const found = join(here, "pkg-nodejs", "switchyard_wasm.js");
if (!existsSync(found)) {
  console.error("nodejs wasm pkg not found. Build it first.");
  process.exit(1);
}
const mod = await import(pathToFileURL(found).href);
console.log(mod.evaluate());
