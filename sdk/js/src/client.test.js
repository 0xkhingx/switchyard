// SDK behavior tests (SPEC.md section 8, SDK row): polling, ETag/304,
// offline fallback, invalid-config rejection, never-throws.
// Run: node --test src/   (no dependencies; uses node:test + a stub server)
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient } from "./client.js";

const CONFIG_V1 = {
  version: 1,
  flags: {
    "new-checkout": {
      type: "bool", enabled: true, offValue: false,
      rules: [{ id: "r1", conditions: [], serve: { fixed: true } }],
      fallthrough: { fixed: false },
    },
  },
};

// Tiny stub for GET /sdk/v1/config with ETag/304 support.
// Sends `Connection: close` so teardown never waits on keep-alive sockets.
function startStub({ key = "sy_test" } = {}) {
  const state = { version: 1, config: structuredClone(CONFIG_V1), hits: 0, notModified: 0, raw: null };
  const server = http.createServer((req, res) => {
    if (req.url !== "/sdk/v1/config") { res.writeHead(404); res.end(); return; }
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end(); return; }
    state.hits += 1;
    if (state.raw !== null) {
      res.writeHead(200, { "Content-Type": "application/json", ETag: `"v${state.version}"`, Connection: "close" });
      res.end(state.raw);
      return;
    }
    const etag = `"v${state.version}"`;
    if (req.headers["if-none-match"] === etag) {
      state.notModified += 1;
      res.writeHead(304, { ETag: etag, Connection: "close" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", ETag: etag, "Cache-Control": "no-cache", Vary: "Authorization", Connection: "close" });
    res.end(JSON.stringify({ ...state.config, version: state.version }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, state, port: server.address().port });
    });
  });
}

function stop(server) {
  return new Promise((resolve) => {
    // Drop any lingering sockets, then close. Guarantees the event loop drains.
    try { server.closeAllConnections(); } catch { /* older node */ }
    server.close(() => resolve());
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("toggle reaches SDK within one poll interval (ETag + change event)", async () => {
  const { server, state, port } = await startStub();
  try {
    const client = createClient({ sdkKey: "sy_test", baseUrl: `http://127.0.0.1:${port}`, pollIntervalMs: 1000 });
    assert.equal(await client.ready(), true);
    assert.equal(client.boolVariation("new-checkout", { key: "u-1" }, false), true);

    let changed = null;
    client.on("change", (v) => { changed = v; });
    // Flip the flag server-side.
    state.version = 2;
    state.config.flags["new-checkout"].rules = [];
    await sleep(2600); // changed version arrives ~1s in; a later poll 304s
    assert.equal(changed, 2, "change event fired with new version");
    assert.equal(client.boolVariation("new-checkout", { key: "u-1" }, true), false);
    assert.ok(state.notModified >= 1, "polling sends If-None-Match and gets 304s");
    client.close();
  } finally {
    await stop(server);
  }
});

test("SDK keeps evaluating after the server is killed", async () => {
  const { server, port } = await startStub();
  const client = createClient({ sdkKey: "sy_test", baseUrl: `http://127.0.0.1:${port}`, pollIntervalMs: 1000 });
  assert.equal(await client.ready(), true);
  assert.equal(client.boolVariation("new-checkout", { key: "u-1" }, false), true);
  await stop(server); // kill the server mid-test
  await sleep(2200); // let polls fail + backoff in the background
  assert.equal(client.boolVariation("new-checkout", { key: "u-1" }, false), true, "last good config still served");
  client.close();
});

test("invalid config is rejected, previous config stays active", async () => {
  const { server, state, port } = await startStub();
  try {
    const client = createClient({ sdkKey: "sy_test", baseUrl: `http://127.0.0.1:${port}`, pollIntervalMs: 1000 });
    assert.equal(await client.ready(), true);
    state.version = 2;
    state.raw = '{"version": 2, "flags": {"x": "not a flag"}}';
    await sleep(1600);
    assert.equal(client.boolVariation("new-checkout", { key: "u-1" }, false), true, "old config still active");
    client.close();
  } finally {
    await stop(server);
  }
});

test("ready() stays unsuccessful when the initial config is invalid", async () => {
  const { server, state, port } = await startStub();
  state.raw = '{"version": 1, "flags": {"x": "not a flag"}}';
  const client = createClient({
    sdkKey: "sy_test", baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 1000, readyTimeoutMs: 200,
  });
  try {
    assert.equal(await client.ready(), false);
    assert.equal(client.boolVariation("new-checkout", { key: "u-1" }, false), false);
  } finally {
    client.close();
    await stop(server);
  }
});

test("ready() resolves false when no config can load; variations return defaults", async () => {
  const client = createClient({
    sdkKey: "sy_test", baseUrl: "http://127.0.0.1:1", pollIntervalMs: 1000, readyTimeoutMs: 800,
  });
  assert.equal(await client.ready(), false, "degraded, no config");
  assert.equal(client.boolVariation("new-checkout", { key: "u-1" }, false), false);
  assert.equal(client.stringVariation("banner", { key: "u-1" }, "hi"), "hi");
  client.close();
});

test("variation calls never throw (unknown flag, wrong type, bad context)", async () => {
  const { server, port } = await startStub();
  try {
    const client = createClient({ sdkKey: "sy_test", baseUrl: `http://127.0.0.1:${port}`, pollIntervalMs: 1000 });
    assert.equal(await client.ready(), true);
    assert.equal(client.boolVariation("nope", { key: "u-1" }, "dflt"), "dflt");
    // bool flag read as string -> default
    assert.equal(client.stringVariation("new-checkout", { key: "u-1" }, "dflt"), "dflt");
    const detail = client.variationDetail("new-checkout", null);
    // A null context normalizes to an empty key; the match-all rule still hits.
    assert.equal(detail.reason, "RULE_MATCH");
    assert.equal(detail.value, true);
    // With no config loaded at all, evaluation is ERROR with a null value.
    const cold = createClient({ sdkKey: "sy_test", baseUrl: "http://127.0.0.1:1", pollIntervalMs: 1000, readyTimeoutMs: 50 });
    assert.deepEqual(cold.variationDetail("new-checkout", { key: "u-1" }), { value: null, reason: "ERROR", ruleId: null });
    cold.close();
    client.close();
  } finally {
    await stop(server);
  }
});

test("a hung config request times out (fetchTimeoutMs) instead of stalling", async () => {
  // Server accepts the request but never answers.
  const server = http.createServer(() => { /* never respond */ });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const client = createClient({
    sdkKey: "sy_test", baseUrl: `http://127.0.0.1:${port}`,
    pollIntervalMs: 1000, readyTimeoutMs: 20_000, fetchTimeoutMs: 200,
  });
  try {
    const started = Date.now();
    assert.equal(await client.ready(), false);
    assert.ok(Date.now() - started < 2000, "request aborted by fetch timeout, not ready timeout");
  } finally {
    client.close();
    await stop(server);
  }
});

test("401/403 backs off to authRetryMs and warns once (no hot retry)", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(hits % 2 ? 401 : 403, { Connection: "close" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  let client;
  try {
    client = createClient({
      sdkKey: "sy_bad", baseUrl: `http://127.0.0.1:${port}`, pollIntervalMs: 1000,
    });
    assert.equal(await client.ready(), false);
    await sleep(2500); // a normal 1s poll/backoff would have retried by now
    assert.equal(hits, 1, "default authRetryMs (5 min) prevents fast retries");
    client.close();

    // A configurable, short authRetryMs retries, but still warns only once.
    hits = 0;
    warnings.length = 0;
    client = createClient({
      sdkKey: "sy_bad", baseUrl: `http://127.0.0.1:${port}`, pollIntervalMs: 1000, authRetryMs: 1000,
    });
    await sleep(2500);
    assert.ok(hits >= 2 && hits <= 3, `retries at authRetryMs (hits=${hits})`);
    assert.equal(warnings.filter((w) => w.includes("rejected")).length, 1, "auth warning logged once");
  } finally {
    console.warn = origWarn;
    client?.close();
    await stop(server);
  }
});

test("close() clears the ready timeout so the process can exit", async () => {
  const { spawn } = await import("node:child_process");
  const clientUrl = new URL("./client.js", import.meta.url).href;
  const script = `
    const { createClient } = await import(${JSON.stringify(clientUrl)});
    const c = createClient({ sdkKey: "sy_test", baseUrl: "http://127.0.0.1:1", readyTimeoutMs: 60000 });
    c.close();
    console.log("ready:" + (await c.ready()));
  `;
  const started = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const killer = setTimeout(() => child.kill(), 15_000);
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(killer);
  assert.equal(code, 0, "child exited on its own");
  assert.ok(Date.now() - started < 10_000, "exit was not held by the 60s ready timer");
  assert.match(out, /ready:false/, "pending ready() resolves false on close");
});
