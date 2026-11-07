// @switchyard/sdk: polling JS wrapper around the WASM Engine (SPEC.md section 6).
//
// - Fetches /sdk/v1/config, loads it into the Engine, polls with If-None-Match.
// - Evaluations are local; a *Variation call never touches the network or throws.
// - On fetch errors it keeps serving the last good config with exponential
//   backoff + jitter (capped at 60s). Invalid configs are rejected, keeping
//   the previous one. close() stops timers and in-flight requests.
// - Each config request is bounded by fetchTimeoutMs (default 10s).
// - 401/403 means the SDK key is wrong or revoked: warn once and retry only
//   every authRetryMs (default 5 minutes) instead of hot-retrying.
import { Engine } from "../pkg-nodejs/switchyard_wasm.js";

const ERROR_EVAL = { value: null, reason: "ERROR", ruleId: null };

export function createClient({
  sdkKey,
  baseUrl,
  pollIntervalMs = 5000,
  readyTimeoutMs = 5000,
  fetchTimeoutMs = 10_000,
  authRetryMs = 300_000,
}) {
  if (!sdkKey) throw new Error("sdkKey is required");
  if (!baseUrl) throw new Error("baseUrl is required");
  const pollMs = Math.max(1000, pollIntervalMs);
  const engine = new Engine();

  let etag = null;
  let timer = null;
  let readyTimer = null;
  let closed = false;
  let aborter = null;
  let backoffMs = pollMs;
  let ready = false;
  let readyResolve = null;
  const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
  const changeListeners = new Set();
  const warned = new Set();

  function markReady(ok) {
    if (!ready) {
      ready = true;
      clearTimeout(readyTimer);
      readyResolve(ok);
    }
  }

  function warnOnce(key, message) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(message);
    }
  }

  function schedule(delayMs) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(tick, delayMs);
  }

  function backoff() {
    // Exponential backoff with jitter, capped at 60 seconds.
    const jitter = Math.random() * 1000;
    const delay = Math.min(backoffMs + jitter, 60_000);
    backoffMs = Math.min(backoffMs * 2, 60_000);
    schedule(delay);
  }

  // Signal that aborts on close() or after fetchTimeoutMs, whichever is first.
  // Uses AbortSignal.any/timeout when available; otherwise a manual timer.
  function requestSignal() {
    const ms = Math.max(1, fetchTimeoutMs);
    if (typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function") {
      return { signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(ms)]), done() {} };
    }
    const combined = new AbortController();
    const onAbort = () => combined.abort(aborter.signal.reason);
    aborter.signal.addEventListener("abort", onAbort, { once: true });
    const t = setTimeout(() => {
      const reason = typeof DOMException === "function"
        ? new DOMException("config request timed out", "TimeoutError")
        : Object.assign(new Error("config request timed out"), { name: "TimeoutError" });
      combined.abort(reason);
    }, ms);
    return {
      signal: combined.signal,
      done() {
        clearTimeout(t);
        aborter.signal.removeEventListener("abort", onAbort);
      },
    };
  }

  async function tick() {
    if (closed) return;
    aborter = new AbortController();
    const req = requestSignal();
    try {
      const headers = { Authorization: `Bearer ${sdkKey}` };
      if (etag) headers["If-None-Match"] = etag;
      const res = await fetch(`${baseUrl}/sdk/v1/config`, {
        headers,
        signal: req.signal,
      });
      if (res.status === 401 || res.status === 403) {
        // Bad or revoked key: retrying fast will not help. Warn once, back off long.
        warnOnce("auth", `switchyard: config request rejected (${res.status}); check the SDK key. Retrying every ${Math.round(authRetryMs / 1000)}s`);
        markReady(false);
        schedule(Math.max(1000, authRetryMs));
        return;
      }
      if (res.status === 304) {
        backoffMs = pollMs;
        markReady(true);
        schedule(pollMs);
        return;
      }
      if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
      const text = await res.text();
      let version;
      try {
        version = engine.load(text);
      } catch (e) {
        // Invalid config: reject it, keep serving the previous one.
        warnOnce("invalid-config", `switchyard: rejecting invalid config (${e?.message ?? e})`);
        backoffMs = pollMs;
        schedule(pollMs);
        return;
      }
      const nextEtag = res.headers.get("etag") ?? `"v${Number(version)}"`;
      etag = nextEtag;
      backoffMs = pollMs;
      markReady(true);
      const v = Number(version);
      for (const cb of changeListeners) {
        try { cb(v); } catch { /* listener errors must not break polling */ }
      }
      schedule(pollMs);
    } catch (e) {
      // Aborts from close() stop here; timeouts fall through to backoff.
      if (closed) return;
      // Offline or server down: keep last good config, retry with backoff.
      markReady(false);
      backoff();
    } finally {
      req.done();
    }
  }

  // Kick off immediately; ready() resolves true on first load, false on timeout.
  tick();
  readyTimer = setTimeout(() => markReady(false), readyTimeoutMs);

  function variationDetail(flagKey, context) {
    try {
      const ctx = context && typeof context === "object"
        ? { key: context.key ?? "", attributes: context.attributes ?? {} }
        : { key: "", attributes: {} };
      return JSON.parse(engine.evaluate(flagKey, JSON.stringify(ctx)));
    } catch {
      return { ...ERROR_EVAL };
    }
  }

  function boolVariation(flagKey, context, defaultValue) {
    const d = variationDetail(flagKey, context);
    if (typeof d.value === "boolean") return d.value;
    warnOnce(`type:${flagKey}`, `switchyard: flag "${flagKey}" did not return a boolean; using default`);
    return defaultValue;
  }

  function stringVariation(flagKey, context, defaultValue) {
    const d = variationDetail(flagKey, context);
    if (typeof d.value === "string") return d.value;
    warnOnce(`type:${flagKey}`, `switchyard: flag "${flagKey}" did not return a string; using default`);
    return defaultValue;
  }

  return {
    ready: () => readyPromise,
    boolVariation,
    stringVariation,
    variationDetail,
    on(event, cb) {
      if (event === "change") changeListeners.add(cb);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(readyTimer);
      markReady(false);
      try { aborter?.abort(); } catch { /* already settled */ }
    },
  };
}
