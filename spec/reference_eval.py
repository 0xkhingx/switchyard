"""Reference evaluator for Switchyard (Python).
Independent implementation of spec/SPEC.md section 3, used to generate and sanity-check
the test vectors. Run: python3 reference_eval.py
"""
import json

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

# sanity checks against well-known values
assert murmur3_32(b"") == 0
assert murmur3_32(b"hello") == 0x248BFA47, hex(murmur3_32(b"hello"))
assert murmur3_32(b"The quick brown fox jumps over the lazy dog") == 0x2E4FF723
print("murmur3 sanity OK")

def bucket(flag_key, ckey):
    return murmur3_32(f"{flag_key}:{ckey}".encode()) % 10000

for k in ["u-1","u-2","u-3","u-4","u-5","u-6","u-7","u-8"]:
    print(k, bucket("new-checkout", k))

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

cfg = {"version": 7, "flags": {
  "new-checkout": {"type":"bool","enabled":True,"offValue":False,
    "rules":[
      {"id":"r1","conditions":[{"attribute":"country","op":"in","values":["NG","GH"]}],"serve":{"fixed":True}},
      {"id":"r2","conditions":[{"attribute":"plan","op":"equals","values":["pro"]}],
       "serve":{"rollout":[{"value":True,"weight":2000},{"value":False,"weight":8000}]}}],
    "fallthrough":{"fixed":False}},
  "banner-text": {"type":"string","enabled":False,"offValue":"Welcome","rules":[],"fallthrough":{"fixed":"Spring sale"}}
}}
cases = [
 ("u-1", {"country":"NG"}),
 ("u-2", {"country":"US","plan":"pro"}),
 ("u-3", {"country":"US","plan":"pro"}),
 ("u-4", {"country":"US","plan":"free"}),
 ("", {"country":"US","plan":"pro"}),
]
for k,a in cases:
    print("new-checkout", k, a, evaluate(cfg,"new-checkout",{"key":k,"attributes":a}))
print("banner-text", evaluate(cfg,"banner-text",{"key":"u-1"}))
print("missing", evaluate(cfg,"nope",{"key":"u-1"}))
# find keys in/out of first 2000 bucket for pro
ins=[f"u-{i}" for i in range(1,60) if bucket("new-checkout",f"u-{i}")<2000][:3]
outs=[f"u-{i}" for i in range(1,60) if bucket("new-checkout",f"u-{i}")>=2000][:3]
print("in20", ins, [bucket("new-checkout",k) for k in ins])
print("out20", outs, [bucket("new-checkout",k) for k in outs])
# sticky: users in 2000 stay in 3000
import collections
n=100000; c=0; s=0
for i in range(n):
    b=bucket("new-checkout",f"user-{i}")
    if b<2000: c+=1
    if b<2000 and not b<3000: s+=1
print("share<2000 over 100k:", c/n, "sticky violations:", s)
