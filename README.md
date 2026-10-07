# Switchyard

A feature flag platform in Rust. One evaluator (`switchyard-core`) runs on the
server and — compiled to WebAssembly — inside the JavaScript SDK, so every
client makes exactly the same decision for the same input.

Cut-line status (M0–M3 + this README): done. Dashboard/demo (M4) and deploy (M5)
are a second pass.

## Architecture

```
Dashboard (M4) ── session cookie ──►┌──────────────────┐
                                     │ switchyard-server│──► Postgres
curl / tests ── session / Bearer ──► │  Axum + sqlx     │     (versions,
                                     └────────┬─────────┘      revisions, audit)
                                              │ GET /sdk/v1/config (ETag)
                                              ▼
                                    ┌──────────────────┐
                                    │  @switchyard/sdk │  polls, caches,
                                    │  JS + WASM Engine│  evaluates locally,
                                    │  (switchyard-    │  survives outages
                                    │   core in WASM)  │
                                    └──────────────────┘
```

`switchyard-core` does no I/O at all, so the same code compiles to native (server)
and `wasm32-unknown-unknown` (SDK). The Python oracle in `spec/` generates the
test vectors both implementations must reproduce.

## Run in one command (per piece)

```powershell
# Core: 13 tests (vectors, properties, validation)
cargo test -p switchyard-core

# All Rust tests (server DB flow skips without DATABASE_URL)
cargo test --workspace

# WASM parity: every vector through the real Engine (needs one build first)
wasm-pack build crates/switchyard-wasm --target nodejs --out-dir ../../sdk/js/pkg-nodejs
node ./sdk/js/parity.mjs

# JS SDK: 5 behavior tests, zero dependencies
node --test sdk/js/src/client.test.js

# Server (needs Postgres; Docker or hosted e.g. Supabase/Neon)
$env:DATABASE_URL = "postgres://switchyard:switchyard@localhost:5432/switchyard"
cargo run -p switchyard-server
# first user: cargo run -p switchyard-server -- create-user --email you@x.com --password <8+ chars> --admin
```

## Design decisions (see `docs/DECISIONS.md`)

| # | Decision | Why |
|---|---|---|
| 1 | WASM boundary passes JSON strings | Simple, robust; `serde-wasm-bindgen` deferred until benchmarks demand it |
| 2 | Hand-rolled murmur3, no crate | The hash is spec-frozen; a wrong crate variant would silently reassign every user |
| 3 | `ts-rs`/`proptest`/`criterion` deferred | Data-light M1; deterministic tests cover the same properties |
| 4 | One-transaction config edits; runtime-checked `sqlx::query` | No silent overwrites (409 on stale revision); builds work without a live DB |
| 5 | `node:test` instead of Vitest for the SDK | Zero downloads; same behaviors covered; revisit at M4 |

Missing attributes never match (even `notEquals`/`notIn`); equality is
type-strict; SDKs poll with `If-None-Match` and keep serving the last good
config offline with capped backoff.

## Benchmarks (measured on this machine, release build)

| Path | Result |
|---|---|
| Native `evaluate` (rollout path) | ~689 ns/eval (~1.45M evals/sec) |
| Native `bucket` (murmur3 + modulo) | ~594 ns/hash (~1.7M hashes/sec) |
| WASM `evaluate` in Node 25 | ~6.9 µs/eval (~146k evals/sec) |

Reproduce: `cargo run --release -p switchyard-core --example bench` and
`node ./sdk/js/bench.mjs`. Roughly a 10x native→WASM gap — expected
(JSON context parse per call + WASM overhead); optimize only if real
traffic says so.

## Verify the cut line

- [x] All vectors + property tests pass natively (`cargo test -p switchyard-core` → 13/13)
- [x] Parity: WASM in Node identical on every vector (`parity.mjs` → 7/7)
- [x] Server non-DB tests pass (5/5); full DB flow test written, runs with `DATABASE_URL` set
- [x] SDK keeps serving after the server is killed (tested)
- [ ] Demo flips live from dashboard → M4
- [x] No secrets in repo; `.env.example` provided
