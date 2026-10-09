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

const engine = new Engine();
let sdkKey = new URLSearchParams(location.search).get("key") || "";
let etag = null;
let timer = null;
let version = null;

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
  try {
    const headers = { Authorization: `Bearer ${sdkKey}` };
    if (etag) headers["If-None-Match"] = etag;
    const res = await fetch(`${API_URL}/sdk/v1/config`, { headers });
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

connectBtn.addEventListener("click", async () => {
  sdkKey = keyInput.value.trim();
  if (!sdkKey) return;
  clearInterval(timer);
  etag = null;
  await init();
  await tick();
  timer = setInterval(tick, POLL_MS);
});
