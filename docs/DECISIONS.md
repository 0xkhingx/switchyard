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

## ADR-003 (note): Deferred to keep M1 data-light
- `ts-rs` type generation, `proptest`, and `criterion` benches move to M3/M5. Same properties are covered now by deterministic tests (including the 100k-key distribution run); the JSON vectors already execute the cross-implementation contract.
