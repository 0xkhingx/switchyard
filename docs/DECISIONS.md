# Decisions

## ADR-001: WASM boundary uses JSON strings
- **Date:** 2026-10-07
- **Status:** Accepted
- **Reversibility:** Two-way door
- **Context:** `switchyard-core` must run identically on server and in JS SDK. Spec §5 fixes the boundary.
- **Decision:** `Engine.load(config_json)` and `Engine.evaluate(flag_key, context_json)` pass JSON strings; `evaluate` returns the `Evaluation` as a JSON string.
- **Mechanism:** Parsed `EnvConfig` held in `Engine`; `load` validates then swaps atomically; `evaluate` never panics across the boundary (bad context → `ERROR`).
- **Alternatives considered:** `serde-wasm-bindgen` (faster, less copying — more complex, deferred); TypeScript port (fallback if `wasm-pack` fights >1 day — drift risk).
- **Consequences:** Simple and robust; some JSON parse cost per load/evaluate of context only.
- **Revisit when:** Evaluation throughput becomes the bottleneck in benchmarks.
- **Links:** SPEC.md §5, §11.

## ADR-002: Hand-rolled murmur3 instead of a crate
- **Date:** 2026-10-07
- **Status:** Accepted
- **Reversibility:** Two-way door
- **Context:** The hash (`murmur3_x86_32`, seed 0, over `flagKey:key`) is frozen by the spec — changing it reassigns every user. Crates differ in variants (x86_32 vs x64_128, seed handling).
- **Decision:** Port the ~30-line function from `reference_eval.py` directly into `switchyard-core`, verified against the spec's hash/bucket tables.
- **Alternatives considered:** `murmur3` crate (less code — risk of wrong variant/default seed, extra supply-chain surface for 30 lines).
- **Consequences:** Zero dependency risk on the most load-bearing function; we own the code and its tests.
- **Revisit when:** Never for v1 (frozen); only if a SIMD-accelerated path is benchmark-justified.
- **Links:** SPEC.md §3.4, §3.6.

## ADR-003 (note): Deferred to keep M1 dependency-light
- `ts-rs` type generation, `proptest`, and `criterion` benches move to M3/M5. Same properties are covered now by deterministic tests (including the 100k-key distribution run); the JSON vectors already execute the cross-implementation contract.

## ADR-004: Config edits in one transaction; runtime-checked SQL
- **Date:** 2026-10-07
- **Status:** Accepted
- **Reversibility:** Two-way door
- **Context:** Two editors must not silently overwrite each other, and SDKs need one cheap version label.
- **Decision:** `PUT` runs `SELECT ... FOR UPDATE` on the flag config, rejects stale `expectedRevision` with 409, writes the row, bumps `environments.version`, and inserts the audit row in a single transaction. Queries use `sqlx::query` (runtime-checked) so the crate builds offline without a live database; migrations are embedded with `sqlx::migrate!`.
- **Alternatives considered:** `sqlx::query!` macros (compile-time checked — needs a live DB at every build, which keeps local builds from working offline); separate revision/version counters merged into one (would make unrelated flag edits conflict).
- **Consequences:** Builds pass without Postgres; SQL typos surface only under a live DB test, so `db_tests::full_flow` (skipped without `DATABASE_URL`) is mandatory before calling M2 done.
- **Revisit when:** A query bug slips past review — then reconsider `cargo sqlx prepare` with a committed `.sqlx/` cache.
- **Links:** SPEC.md §4.3, §4.5.

## ADR-005: SDK tests run on node:test, not Vitest
- **Date:** 2026-10-07
- **Status:** Accepted
- **Reversibility:** Two-way door
- **Context:** Keeps installs minimal — Vitest would pull a large toolchain for what are five behavioral tests over a stub HTTP server.
- **Decision:** Plain-JS SDK tested with Node's built-in `node:test` (zero downloads); same behaviors as the spec's Vitest row (polling, ETag/304, backoff, offline, invalid-config, never-throws) plus a parity script running every vector through the real WASM build.
- **Alternatives considered:** Vitest (nicer DX, spec's pick — migrate when the dashboard needs a shared setup).
- **Consequences:** No watch mode or browser harness yet; web-target WASM is built and export-checked but exercised fully only in Node until the dashboard lands.
- **Revisit when:** M4 dashboard work starts.
- **Links:** SPEC.md §6, §8.
