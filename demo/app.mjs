// Demo glue: polls /sdk/v1/config into the real WASM Engine and renders
// two flags. Demo-only polling loop (the published @switchyard/sdk has the
// full client with backoff); evaluation itself runs in switchyard-core.
import init, { Engine } from "../sdk/js/pkg-web/switchyard_wasm.js";

const API_URL = "http://localhost:8080";
const POLL_MS = 2000;

const keyInput = document.getElementById("sdk-key");
const connectBtn = document.getElementById("connect");
const dot = document.getElementById("dot");
const statusEl = document.getElementById("status");
const banner = document.getElementById("banner");
const cta = document.getElementById("cta");
const log = document.getElementById("log");

const engineHolder = { engine: null };

// The key comes from the form field and is remembered for this tab only
// (sessionStorage), never from the URL, so it does not leak via history,
// bookmarks, Referer headers or server logs.
const KEY_STORAGE = "switchyard-demo-sdk-key";

function loadKey() {
  try { return sessionStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
}

function saveKey(key) {
  try { sessionStorage.setItem(KEY_STORAGE, key); } catch { /* storage unavailable */ }
}

let sdkKey = loadKey();
let etag = null;
let timer = null;
let version = null;
// Bumped on every Connect so a poll loop from an earlier key stops itself.
let generation = 0;

if (sdkKey) keyInput.value = sdkKey;

function setStatus(ok, text) {
  dot.className = "dot" + (ok === true ? " ok" : ok === false ? " bad" : "");
  statusEl.textContent = text;
}

function logEval(flag, detail) {
  const li = document.createElement("li");
  const time = new Date().toLocaleTimeString();
  li.innerHTML = "";
  const code = document.createElement("code");
  code.textContent = `${flag} → ${JSON.stringify(detail.value)} (${detail.reason})`;
  li.append(`${time} `, code);
  log.prepend(li);
  while (log.children.length > 8) log.lastChild.remove();
}

function render() {
  const engine = engineHolder.engine;
  if (!engine) return;
  const ctx = JSON.stringify({ key: "demo-user", attributes: {} });
  try {
    const b = JSON.parse(engine.evaluate("demo-banner", ctx));
    banner.classList.toggle("show", b.value === true);
    logEval("demo-banner", b);
  } catch {
    /* engine without config: skip render */
  }
  try {
    const c = JSON.parse(engine.evaluate("demo-cta", ctx));
    if (typeof c.value === "string" && c.value) cta.textContent = c.value;
    logEval("demo-cta", c);
  } catch {
    /* skip */
  }
}

async function tick() {
  const engine = engineHolder.engine;
  if (!engine) return;
  const gen = generation;
  try {
    const headers = { Authorization: `Bearer ${sdkKey}` };
    if (etag) headers["If-None-Match"] = etag;
    const res = await fetch(`${API_URL}/sdk/v1/config`, { headers });
    if (gen !== generation) return; // superseded by a newer Connect
    if (res.status === 304) {
      setStatus(true, `Connected · config v${version} · polling every ${POLL_MS / 1000}s`);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    version = Number(await (async () => {
      const text = await res.text();
      return engine.load(text);
    })());
    etag = res.headers.get("etag") ?? `"v${version}"`;
    setStatus(true, `Connected · config v${version} · polling every ${POLL_MS / 1000}s`);
    render();
  } catch (e) {
    setStatus(false, `Connection failed (${e.message}). Retrying…`);
  }
}

// Self-scheduling loop: the next poll is queued only after the current one
// finishes, so slow requests never overlap.
async function pollLoop(gen) {
  await tick();
  if (gen !== generation) return;
  timer = setTimeout(() => pollLoop(gen), POLL_MS);
}

connectBtn.addEventListener("click", async () => {
  sdkKey = keyInput.value.trim();
  if (!sdkKey) return;
  saveKey(sdkKey);
  clearTimeout(timer);
  const gen = ++generation;
  etag = null;
  version = null;
  try {
    await init();
  } catch (e) {
    setStatus(false, `Could not load the evaluator (${e.message}).`);
    return;
  }
  if (gen !== generation) return;
  engineHolder.engine = new Engine();
  pollLoop(gen);
});
