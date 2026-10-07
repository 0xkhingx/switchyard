"""Generate spec/vectors/*.json from the reference evaluator logic.

Mirrors spec/reference_eval.py (kept independent: functions are duplicated here
rather than imported, because importing would execute its top-level asserts).
Run: python3 spec/gen_vectors.py
"""
import json
import pathlib

# --- murmur3_x86_32 / bucket / cond_match / serve / evaluate: ports of reference_eval.py ---

def murmur3_32(data: bytes, seed: int = 0) -> int:
    c1, c2 = 0xCC9E2D51, 0x1B873593
    h = seed & 0xFFFFFFFF
    n = len(data)
    nblocks = n // 4
    for i in range(nblocks):
        k = int.from_bytes(data[4*i:4*i+4], "little")
        k = (k * c1) & 0xFFFFFFFF
        k = ((k << 15) | (k >> 17)) & 0xFFFFFFFF
        k = (k * c2) & 0xFFFFFFFF
        h ^= k
        h = ((h << 13) | (h >> 19)) & 0xFFFFFFFF
        h = (h * 5 + 0xE6546B64) & 0xFFFFFFFF
    tail = data[nblocks*4:]
    k = 0
    if len(tail) >= 3: k ^= tail[2] << 16
    if len(tail) >= 2: k ^= tail[1] << 8
    if len(tail) >= 1:
        k ^= tail[0]
        k = (k * c1) & 0xFFFFFFFF
        k = ((k << 15) | (k >> 17)) & 0xFFFFFFFF
        k = (k * c2) & 0xFFFFFFFF
        h ^= k
    h ^= n
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & 0xFFFFFFFF
    h ^= h >> 16
    return h

def bucket(flag_key, ckey):
    return murmur3_32(f"{flag_key}:{ckey}".encode()) % 10000

def cond_match(cond, ctx):
    attr = cond["attribute"]
    val = ctx["key"] if attr == "key" else ctx.get("attributes", {}).get(attr)
    if val is None: return False
    op, vs = cond["op"], cond["values"]
    def same(a,b): return type(a)==type(b) and a==b
    if op=="equals": return same(val, vs[0])
    if op=="notEquals": return not same(val, vs[0])
    if op=="in": return any(same(val,v) for v in vs)
    if op=="notIn": return not any(same(val,v) for v in vs)
    if op=="contains": return isinstance(val,str) and vs[0] in val
    if op=="startsWith": return isinstance(val,str) and val.startswith(vs[0])
    if op=="endsWith": return isinstance(val,str) and val.endswith(vs[0])
    return False

def serve(flag, s, ctx, rule_id, reason):
    if "fixed" in s: return {"value": s["fixed"], "reason": reason, "ruleId": rule_id}
    if not ctx.get("key"): return {"value": flag["offValue"], "reason":"ERROR","ruleId":None}
    b = bucket(flag["key"], ctx["key"]); cum = 0
    for r in s["rollout"]:
        cum += r["weight"]
        if b < cum: return {"value": r["value"], "reason": reason, "ruleId": rule_id}

def evaluate(cfg, key, ctx):
    flag = cfg["flags"].get(key)
    if flag is None: return {"value": None, "reason": "FLAG_NOT_FOUND", "ruleId": None}
    flag = {**flag, "key": key}
    if not flag["enabled"]: return {"value": flag["offValue"], "reason":"OFF","ruleId":None}
    for r in flag["rules"]:
        if all(cond_match(c, ctx) for c in r["conditions"]):
            return serve(flag, r["serve"], ctx, r["id"], "RULE_MATCH")
    return serve(flag, flag["fallthrough"], ctx, None, "FALLTHROUGH")

# --- config shared with SPEC.md section 2.1 ---

CONFIG = {"version": 7, "flags": {
  "new-checkout": {"type":"bool","enabled":True,"offValue":False,
    "rules":[
      {"id":"r1","conditions":[{"attribute":"country","op":"in","values":["NG","GH"]}],"serve":{"fixed":True}},
      {"id":"r2","conditions":[{"attribute":"plan","op":"equals","values":["pro"]}],
       "serve":{"rollout":[{"value":True,"weight":2000},{"value":False,"weight":8000}]}}],
    "fallthrough":{"fixed":False}},
  "banner-text": {"type":"string","enabled":False,"offValue":"Welcome","rules":[],"fallthrough":{"fixed":"Spring sale"}}
}}

out = pathlib.Path(__file__).parent / "vectors"
out.mkdir(exist_ok=True)

hashes = [
    {"input": "", "hash": murmur3_32(b"")},
    {"input": "hello", "hash": murmur3_32(b"hello")},
    {"input": "The quick brown fox jumps over the lazy dog",
     "hash": murmur3_32(b"The quick brown fox jumps over the lazy dog")},
]
assert hashes[0]["hash"] == 0
assert hashes[1]["hash"] == 0x248BFA47
assert hashes[2]["hash"] == 0x2E4FF723
(out / "hash.json").write_text(json.dumps(hashes, indent=2) + "\n")

keys = ["u-1","u-2","u-3","u-4","u-5","u-6","u-7","u-8"]
expected_buckets = {"u-1":9373,"u-2":322,"u-3":6066,"u-4":7192,
                    "u-5":1826,"u-6":8222,"u-7":6635,"u-8":227}
got = [{"key": k, "bucket": bucket("new-checkout", k)} for k in keys]
assert {g["key"]: g["bucket"] for g in got} == expected_buckets
(out / "buckets.json").write_text(
    json.dumps({"flag": "new-checkout", "vectors": got}, indent=2) + "\n")

cases = [
  {"flag": "new-checkout",
   "context": {"key": "u-1", "attributes": {"country": "NG"}}},
  {"flag": "new-checkout",
   "context": {"key": "u-2", "attributes": {"country": "US", "plan": "pro"}}},
  {"flag": "new-checkout",
   "context": {"key": "u-3", "attributes": {"country": "US", "plan": "pro"}}},
  {"flag": "new-checkout",
   "context": {"key": "u-4", "attributes": {"country": "US", "plan": "free"}}},
  {"flag": "new-checkout",
   "context": {"key": "", "attributes": {"country": "US", "plan": "pro"}}},
  {"flag": "banner-text", "context": {"key": "u-1", "attributes": {}}},
  {"flag": "nope", "context": {"key": "u-1", "attributes": {}}},
]
for c in cases:
    c["expected"] = evaluate(CONFIG, c["flag"], c["context"])
(out / "evaluations.json").write_text(
    json.dumps({"config": CONFIG, "cases": cases}, indent=2) + "\n")

n = 100000
hits = sum(1 for i in range(n) if bucket("new-checkout", f"user-{i}") < 2000)
share = hits / n
assert 0.19 <= share <= 0.21, share
assert all(not (bucket("new-checkout", f"user-{i}") < 2000)
           or bucket("new-checkout", f"user-{i}") < 3000 for i in range(n))
(out / "distribution.json").write_text(json.dumps({
    "flag": "new-checkout", "total": n, "prefix": "user-",
    "threshold": 2000, "share": share, "min_share": 0.19, "max_share": 0.21,
    "sticky_from": 2000, "sticky_to": 3000,
}, indent=2) + "\n")

print(f"wrote 4 vector files to {out} (distribution share={share:.4f})")
