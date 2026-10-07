# Switchyard: Build Spec

A feature flag platform written in Rust. One evaluator (`switchyard-core`) runs in the server and, compiled to WebAssembly, inside the JavaScript SDK, so every client makes exactly the same decision for the same input.

Status: v1 spec. Target: about three weeks, one person.

---

## 0. Goals and non-goals

**Goals**
1. A correct, deterministic evaluator with sticky percentage rollouts.
2. A management API with auth, RBAC and a tamper-evident audit trail.
3. An SDK that evaluates locally, stays current by polling, and keeps working when the server is down.
4. A thin dashboard and a demo app that shows a flag flipping live.

**Non-goals (v1)**
Experiments and metrics, scheduled flags, SSO, billing, multi-tenant organizations, numeric comparison operators (`gt`/`lt`), email delivery, SDKs beyond JavaScript.

**Stretch (only after milestone 3 is done)**
SSE streaming updates, Python SDK via PyO3, login throttling, numeric operators, Rust-native SDK.

---

## 1. Repository layout

```
switchyard/
├── Cargo.toml                  # workspace
├── crates/
│   ├── switchyard-core/        # types, validation, evaluator, bucketing (no I/O)
│   ├── switchyard-server/      # Axum, sqlx, auth, RBAC, audit
│   └── switchyard-wasm/        # wasm-bindgen wrapper around core
├── sdk/js/                     # @switchyard/sdk: TypeScript wrapper + wasm build
├── dashboard/                  # Next.js (App Router, TypeScript)
├── demo/                       # tiny page that flips live
├── spec/
│   ├── SPEC.md
│   ├── reference_eval.py       # independent reference evaluator that generated the vectors
│   └── vectors/                # JSON test vectors (committed in milestone 1)
└── docker-compose.yml          # Postgres for local dev
```

`switchyard-core` must stay free of I/O, threads, clocks and randomness. That keeps it compilable to WASM and trivially testable.

---

## 2. Data model on the wire

### 2.1 Environment config (what SDKs download)

```json
{
  "version": 7,
  "flags": {
    "new-checkout": {
      "type": "bool",
      "enabled": true,
      "offValue": false,
      "rules": [
        {
          "id": "r1",
          "conditions": [{ "attribute": "country", "op": "in", "values": ["NG", "GH"] }],
          "serve": { "fixed": true }
        },
        {
          "id": "r2",
          "conditions": [{ "attribute": "plan", "op": "equals", "values": ["pro"] }],
          "serve": { "rollout": [
            { "value": true,  "weight": 2000 },
            { "value": false, "weight": 8000 }
          ] }
        }
      ],
      "fallthrough": { "fixed": false }
    }
  }
}
```

`version` is the environment version (section 4.3). Archived flags are not included.

### 2.2 Context (what the app passes in)

```json
{ "key": "user-123", "attributes": { "country": "NG", "plan": "pro", "beta": true } }
```

`key` is required for rollouts. Attribute values are `bool`, `number` or `string`.

### 2.3 Evaluation result

```json
{ "value": true, "reason": "RULE_MATCH", "ruleId": "r1" }
```

`reason` is one of `OFF`, `RULE_MATCH`, `FALLTHROUGH`, `FLAG_NOT_FOUND`, `ERROR`. `ruleId` is null unless `reason` is `RULE_MATCH`. For `FLAG_NOT_FOUND`, `value` is null.

---

## 3. Core: `switchyard-core`

### 3.1 Types

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Variant { Bool(bool), Str(String) }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum AttrValue { Bool(bool), Num(f64), Str(String) }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FlagType { Bool, String }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Op { Equals, NotEquals, In, NotIn, Contains, StartsWith, EndsWith }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Condition { pub attribute: String, pub op: Op, pub values: Vec<AttrValue> }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WeightedVariant { pub value: Variant, pub weight: u32 } // basis points

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Serve { Fixed(Variant), Rollout(Vec<WeightedVariant>) }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Rule { pub id: String, pub conditions: Vec<Condition>, pub serve: Serve }

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlagConfig {
    #[serde(rename = "type")] pub kind: FlagType,
    pub enabled: bool,
    pub off_value: Variant,
    pub rules: Vec<Rule>,
    pub fallthrough: Serve,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct EnvConfig { pub version: u64, pub flags: HashMap<String, FlagConfig> }

pub struct Context { pub key: String, pub attributes: HashMap<String, AttrValue> }

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Reason { Off, RuleMatch, Fallthrough, FlagNotFound, Error }

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation { pub value: Option<Variant>, pub reason: Reason, pub rule_id: Option<String> }
```

TypeScript types for the dashboard and SDK are generated from these Rust types with `ts-rs`, so they cannot drift.

### 3.2 Evaluation algorithm

```
evaluate(config, flagKey, context):
  flag = config.flags[flagKey]
  if none                      -> { value: null, reason: FLAG_NOT_FOUND }
  if !flag.enabled             -> { value: flag.offValue, reason: OFF }
  for rule in flag.rules (in order):
      if every condition in rule.conditions matches(context):
          return serve(rule.serve, reason = RULE_MATCH, ruleId = rule.id)
  return serve(flag.fallthrough, reason = FALLTHROUGH)

serve(s, ...):
  if s is Fixed(v)             -> v
  if s is Rollout(buckets):
      if context.key is empty  -> { value: flag.offValue, reason: ERROR }
      b = bucket(flagKey, context.key)
      cumulative = 0
      for (value, weight) in buckets (in order):
          cumulative += weight
          if b < cumulative    -> value
```

### 3.3 Condition semantics

- All conditions in one rule are combined with AND. To express OR, use several rules (first match wins).
- A rule with no conditions matches everyone.
- The special attribute name `key` refers to `context.key`.
- **A missing attribute never matches**, for every operator including `notEquals` and `notIn`. This avoids surprise matches for users you know nothing about.
- Equality is type-strict: the number `1` does not equal the string `"1"`.
- String operators (`contains`, `startsWith`, `endsWith`) are case-sensitive and match only when the attribute is a string.
- `equals`, `notEquals`, `contains`, `startsWith`, `endsWith` use `values[0]`. `in` and `notIn` check the whole list.

### 3.4 Bucketing

```
input  = flagKey + ":" + context.key          // UTF-8 bytes
hash   = murmur3_x86_32(input, seed = 0)      // u32
bucket = hash % 10_000                        // 0..=9999
```

- Weights are in basis points (1% = 100) and must sum to exactly 10 000.
- A variant owns the half-open range `[sum of earlier weights, sum including itself)`.
- **Stickiness:** if the *first* variant's weight grows (2000 to 3000, the others shrinking), every user already in it stays in it.
- The modulo bias of `2^32 % 10 000` is below one in a million and is ignored.
- Changing the hash function or the input format reassigns every user. It is part of the spec and must not change in v1.

### 3.5 Validation

`validate(&EnvConfig) -> Vec<ValidationError>` (each error carries a JSON-pointer path). Rules:

| Rule | Limit |
|---|---|
| Flag key | `^[a-z0-9][a-z0-9._-]{0,63}$` |
| Rule ids | unique within a flag, 1 to 32 characters |
| Rules per flag | at most 50 |
| Conditions per rule | at most 20 |
| Values per condition | `in`/`notIn`: 1 to 100; all other operators: exactly 1 |
| String operators | value must be a string |
| Variants | type must match the flag's `type` |
| String variant length | at most 256 bytes |
| Rollout weights | each 0 to 10 000, total exactly 10 000, at least 1 entry |

The server validates before saving. The SDK validates on load and **rejects an invalid config**, keeping the previous one.

### 3.6 Test vectors

Generated with `spec/reference_eval.py`, which is an independent implementation.

**Hash (murmur3_x86_32, seed 0)**

| Input | Hash |
|---|---|
| `""` | `0x00000000` |
| `"hello"` | `0x248BFA47` |
| `"The quick brown fox jumps over the lazy dog"` | `0x2E4FF723` |

**Buckets** for `flagKey = "new-checkout"`

| context key | bucket |
|---|---|
| `u-1` | 9373 |
| `u-2` | 322 |
| `u-3` | 6066 |
| `u-4` | 7192 |
| `u-5` | 1826 |
| `u-6` | 8222 |
| `u-7` | 6635 |
| `u-8` | 227 |

**Evaluations** against the config in section 2.1, plus a second flag `banner-text` (`type: "string"`, `enabled: false`, `offValue: "Welcome"`, `fallthrough: {fixed: "Spring sale"}`)

| Flag | Context | Expected |
|---|---|---|
| `new-checkout` | key `u-1`, country `NG` | `true`, `RULE_MATCH`, `r1` |
| `new-checkout` | key `u-2`, country `US`, plan `pro` | `true`, `RULE_MATCH`, `r2` (bucket 322 < 2000) |
| `new-checkout` | key `u-3`, country `US`, plan `pro` | `false`, `RULE_MATCH`, `r2` (bucket 6066 >= 2000) |
| `new-checkout` | key `u-4`, country `US`, plan `free` | `false`, `FALLTHROUGH` |
| `new-checkout` | key `""`, country `US`, plan `pro` | `false`, `ERROR` (rollout with no key) |
| `banner-text` | key `u-1` | `"Welcome"`, `OFF` |
| `nope` | key `u-1` | `null`, `FLAG_NOT_FOUND` |

**Distribution check.** For flag `new-checkout`, 100 000 keys `user-0` to `user-99999`, a 2000 bp bucket: the reference run gives 19.83%. The test requires 19% to 21%, and requires that for every key in the first 2000, raising the weight to 3000 keeps it included.

In milestone 1 these tables are committed as JSON under `spec/vectors/` and executed by the Rust tests, and later by the WASM build in Node (section 8).

---

## 4. Server: `switchyard-server`

**Stack:** Axum, `tokio`, `sqlx` (Postgres, compile-time-checked queries, `cargo sqlx prepare` for offline builds), `tower-http` (CORS, tracing, compression), `argon2`, `sha2`, `tracing`.

### 4.1 Schema

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE,  -- stored lowercased
  password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE projects (
  id uuid PRIMARY KEY, key text NOT NULL UNIQUE, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE memberships (
  project_id uuid REFERENCES projects ON DELETE CASCADE,
  user_id uuid REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','editor','viewer')),
  PRIMARY KEY (project_id, user_id));

CREATE TABLE environments (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  key text NOT NULL, name text NOT NULL,
  protected boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,              -- distribution version (ETag)
  UNIQUE (project_id, key));

CREATE TABLE flags (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  key text NOT NULL, type text NOT NULL CHECK (type IN ('bool','string')),
  description text NOT NULL DEFAULT '', archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, key));

CREATE TABLE flag_configs (
  flag_id uuid REFERENCES flags ON DELETE CASCADE,
  environment_id uuid REFERENCES environments ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  off_value jsonb NOT NULL, fallthrough jsonb NOT NULL, rules jsonb NOT NULL DEFAULT '[]',
  revision bigint NOT NULL DEFAULT 1,             -- optimistic concurrency for editors
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES users,
  PRIMARY KEY (flag_id, environment_id));

CREATE TABLE sdk_keys (
  id uuid PRIMARY KEY, environment_id uuid NOT NULL REFERENCES environments ON DELETE CASCADE,
  name text NOT NULL, prefix text NOT NULL,       -- first 8 chars, for display
  key_hash bytea NOT NULL UNIQUE,                 -- sha256 of the full key
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, project_id uuid NOT NULL, environment_id uuid,
  flag_key text, actor_id uuid NOT NULL, action text NOT NULL,
  before jsonb, after jsonb, created_at timestamptz NOT NULL DEFAULT now());
```

Rules are stored as JSONB because they are always read and written as a whole and shipped to SDKs as a whole. Their shape is enforced by the `switchyard-core` types, not by the database.

### 4.2 Auth

- **Dashboard sessions:** opaque 32-byte random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production). Only the SHA-256 of the token is stored. Seven-day expiry. Passwords use argon2id.
- **SDK keys:** `sy_` plus 32 random bytes, base64url. Shown **once** at creation, stored as SHA-256 only. SDK keys can only call `/sdk/*`.
- **CSRF:** mutating endpoints accept only `application/json`, the cookie is `SameSite=Lax`, and CORS allows credentials only from the configured dashboard origin.
- **Bootstrap:** no public sign-up. `switchyard-server create-user --email ... --admin` creates the first user. Project admins add members by email and set an initial password (no email delivery in v1).

### 4.3 Versions and concurrency

There are two counters, for two different jobs:

- `environments.version` is the **distribution** version. It bumps on every change in that environment and becomes the ETag.
- `flag_configs.revision` is the **editing** version for one flag in one environment. It prevents two editors from silently overwriting each other without making unrelated flag edits conflict.

A config update runs in **one transaction**:

1. `SELECT ... FOR UPDATE` the `flag_configs` row; if `revision != expectedRevision`, return `409`.
2. Update the row and set `revision = revision + 1`.
3. `UPDATE environments SET version = version + 1 ... RETURNING version`.
4. Insert the audit row with `before` and `after`.
5. Commit. All of it happens or none of it.

Creating or archiving a flag also bumps the version of every environment it touches.

### 4.4 RBAC

| Action | viewer | editor | admin |
|---|---|---|---|
| Read flags, configs, audit log | yes | yes | yes |
| Create or archive flags | no | yes | yes |
| Edit config in a non-protected environment | no | yes | yes |
| Edit config in a **protected** environment | no | no | yes |
| Manage environments, SDK keys, members | no | no | yes |

### 4.5 API

Management endpoints use the session cookie. All bodies are JSON. Validation failures return `422` with a list of `{ path, message }`.

| Method and path | Purpose |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me` | Session handling |
| `GET/POST /api/projects` | List or create projects |
| `GET/POST /api/projects/:p/environments` | List or create environments |
| `GET/POST /api/projects/:p/flags` | List or create flags |
| `PATCH /api/projects/:p/flags/:key` | Edit description, archive |
| `GET /api/projects/:p/environments/:e/flags/:key` | Read one flag's config (includes `revision`) |
| `PUT /api/projects/:p/environments/:e/flags/:key` | Update config. Body: `{ expectedRevision, enabled, offValue, rules, fallthrough }` |
| `POST /api/evaluate` | Body: `{ config (draft FlagConfig), flagKey, context }`. Runs the real evaluator for the dashboard test panel |
| `GET/POST/DELETE /api/projects/:p/environments/:e/sdk-keys` | Manage SDK keys |
| `GET/POST /api/projects/:p/members` | Manage members |
| `GET /api/projects/:p/audit` | Audit log, newest first, paginated |

SDK endpoint (`Authorization: Bearer <sdk key>`):

| Method and path | Purpose |
|---|---|
| `GET /sdk/v1/config` | Full environment config. Response has `ETag: "v<version>"`, `Cache-Control: no-cache`, `Vary: Authorization`. If `If-None-Match` equals the current version, return `304` **without building the body** |

The audit log has no update or delete endpoints.

---

## 5. WASM: `switchyard-wasm`

```rust
#[wasm_bindgen]
pub struct Engine { config: Option<EnvConfig> }

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)] pub fn new() -> Engine;
    pub fn load(&mut self, config_json: &str) -> Result<u64, JsError>; // validates; returns version
    pub fn version(&self) -> Option<u64>;
    pub fn evaluate(&self, flag_key: &str, context_json: &str) -> String; // Evaluation as JSON
}
```

- The `Engine` holds the **parsed** config, so evaluations don't reparse JSON.
- `load` replaces the config atomically, and only after it validates.
- `evaluate` never panics across the boundary. A malformed context returns `{ "reason": "ERROR", ... }`.
- JSON strings cross the boundary in v1 (simple and robust). `serde-wasm-bindgen` is a possible later optimization.
- Build with `wasm-pack` for both `nodejs` and `web` targets, exposed through conditional exports in the SDK package.

---

## 6. JavaScript SDK: `@switchyard/sdk`

```ts
const client = createClient({
  sdkKey, baseUrl,
  pollIntervalMs: 5000,   // minimum 1000
  readyTimeoutMs: 5000,
});
await client.ready();     // resolves true if a config loaded, false if timed out (degraded)

client.boolVariation("new-checkout", { key: user.id, attributes: { country: "NG" } }, false);
client.stringVariation("banner-text", { key: user.id }, "Welcome");
client.variationDetail("new-checkout", ctx);   // full Evaluation
client.on("change", (version) => { /* config updated */ });
client.close();
```

**Behavior**
1. Fetch `/sdk/v1/config`, call `engine.load`, and then poll with `If-None-Match`. A `304` means do nothing.
2. Evaluations are local. No network call is ever made inside a `*Variation` call.
3. **Offline resilience:** on any fetch error, keep serving the last good config and retry with exponential backoff and jitter, capped at 60 seconds. If no config has ever loaded, return the caller's default.
4. A config that fails validation is rejected and the previous config stays active.
5. **Never throw** from a `*Variation` call. Wrong flag type, unknown flag, bad context: return the default and log once.
6. `close()` stops timers and in-flight requests.

---

## 7. Dashboard and demo

**Dashboard** (Next.js, App Router, TypeScript, no state library; `fetch` with credentials against the server):

1. **Login.**
2. **Project and environment switcher**, with a visible badge on protected environments.
3. **Flag list:** key, type, enabled toggle, last updated. Creating a flag opens a small form.
4. **Flag detail:** rule list (add, reorder, delete), a condition editor, a rollout editor (weighted variants, with a slider for the bool case), off value, fallthrough, and a **Test panel** that calls `/api/evaluate` with the draft rules. It shows the value, the reason and the matching rule.
5. **Audit log:** who, what, when, with a before/after diff.
6. A save that returns `409` tells the user someone else changed the flag and offers to reload.

**Demo app:** a static page using the SDK with a short poll interval. It shows two or three flags controlling visible UI (a banner, a button variant). Flip a toggle in the dashboard and the page changes within a few seconds. This is the main thing to screen-record.

---

## 8. Testing

| Layer | What | Tooling |
|---|---|---|
| Core unit | Operators, missing-attribute rule, validation errors | `cargo test` |
| Vectors | Section 3.6 JSON vectors | Rust test, then the same files run against the WASM build in Node |
| Properties | Determinism; weights partition the bucket space; stickiness when the first weight grows; distribution within tolerance | `proptest` |
| Server | Auth, RBAC matrix, 409 on stale revision, version bump and audit row in the same transaction, ETag/304 | `#[sqlx::test]` |
| SDK | Polling, ETag, backoff, offline fallback, invalid config rejected, never throws | Vitest with a tiny local HTTP server |
| Parity | WASM in Node returns the same result as native for every vector | Vitest |
| Smoke | Create flag, edit rules, SDK sees the change, kill server, SDK keeps evaluating | A script run in CI |

Benchmark `evaluate` with `criterion` (native) and a simple loop in Node (WASM). Record the numbers in the README.

---

## 9. Milestones

**Day 0, WASM spike (half a day).** Build a throwaway `switchyard-wasm` crate that exposes `evaluate()` returning a hardcoded result. Load the `nodejs` build from a script and the `web` build from a Vite page. *Done when:* both print a result. If this fights you for more than a day, switch to the fallback: a TypeScript port of the evaluator in the SDK, held to the same vectors.

**M1, Core (days 1 to 4).** Types, validation, evaluator, bucketing, `ts-rs` generation, vectors committed. *Done when:* all vectors pass, the distribution and stickiness tests pass, and `cargo test` is green.

**M2, Server (days 5 to 9).** Migrations, auth and sessions, RBAC, CRUD, versioned config updates with audit, SDK keys, `/sdk/v1/config` with ETag, `/api/evaluate`. *Done when:* the whole flow works with `curl` and the server integration tests pass.

**M3, WASM and SDK (days 10 to 13).** Real `Engine`, the SDK with polling, ETag, backoff and offline fallback. *Done when:* a toggle reaches the SDK within one poll interval, killing the server does not break evaluations, and the parity test passes.

**M4, Dashboard and demo (days 14 to 18).** All screens in section 7 and the live demo.

**M5, Polish (days 19 to 21).** README with an architecture diagram and a "design decisions" section, benchmark numbers, deploy, a short GIF.

**Cut line:** M1 to M3 plus a README is a finished project. M4 can be bare-bones.

---

## 10. Definition of done

- [ ] All vectors and property tests pass natively and in WASM
- [ ] Server integration tests pass, including RBAC and 409 cases
- [ ] SDK keeps serving after the server is killed
- [ ] Demo flips live from the dashboard
- [ ] README: architecture diagram, how to run in one command, decisions, benchmark numbers
- [ ] Deployed instance (or recorded GIF if hosting is unavailable)
- [ ] No secrets in the repo; `.env.example` provided

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| WASM packaging friction (`wasm-pack` targets, bundlers) | Day 0 spike; fallback to a TypeScript evaluator held to the same vectors |
| `sqlx` offline mode in Docker builds | Commit `.sqlx/` query data; run `cargo sqlx prepare` in CI |
| CORS and cookies between dashboard and server | Fixed dashboard origin, `SameSite=Lax`, test early in M2 |
| Scope creep into stretch goals | Stretch list in section 0 stays closed until M3 is done |
| Hash or input format changed after launch | Frozen by this spec; covered by hash and bucket vectors |

---

## 12. Decision log

| Decision | Chosen | Passed on | Why |
|---|---|---|---|
| Evaluator sharing | One Rust core, WASM for JS | Reimplementing per SDK | Cannot drift; one source of truth |
| Hash | murmur3_x86_32 | SHA-1, xxhash | Fast, well-distributed, simple, easy to verify against known vectors |
| Rollout shape | Weighted variants in basis points | A single percentage | Handles bool and multi-variant with one mechanism; stickiness preserved |
| Rule storage | JSONB on `flag_configs` | A relational rules table | Rules are read, written and shipped whole; fewer joins |
| Two counters | `version` per environment, `revision` per flag config | One counter | Unrelated edits shouldn't conflict; SDKs need one cheap ETag |
| Dashboard auth | Session cookies | JWTs | Revocable, simple |
| SDK key storage | SHA-256 | argon2 | Keys are high-entropy random, a fast hash is sufficient |
| Updates to SDKs | ETag polling | SSE first | Cheap, simple, works everywhere; SSE is a stretch |
| Database access | `sqlx` | Diesel, SeaORM | SQL stays visible; compile-time checks without a heavy ORM |
| WASM boundary | JSON strings | `serde-wasm-bindgen` | Simpler and more robust for v1 |
| Shared types | `ts-rs` generated | Hand-written TS types | No drift between Rust and TypeScript |
| Missing attribute | Never matches | Treat as null | No surprise matches for unknown users |
