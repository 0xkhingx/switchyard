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
