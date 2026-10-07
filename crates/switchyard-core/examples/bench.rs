//! Quick throughput probe for README numbers (not a criterion bench).
//! Run: cargo run --release -p switchyard-core --example bench
use std::collections::HashMap;
use std::time::Instant;
use switchyard_core::{AttrValue, Context, EnvConfig, bucket, evaluate};

fn main() {
    let config: EnvConfig = serde_json::from_value(serde_json::json!({
        "version": 7,
        "flags": {
            "new-checkout": {
                "type": "bool", "enabled": true, "offValue": false,
                "rules": [
                    {"id": "r1",
                     "conditions": [{"attribute": "country", "op": "in", "values": ["NG", "GH"]}],
                     "serve": {"fixed": true}},
                    {"id": "r2",
                     "conditions": [{"attribute": "plan", "op": "equals", "values": ["pro"]}],
                     "serve": {"rollout": [{"value": true, "weight": 2000},
                                            {"value": false, "weight": 8000}]}}],
                "fallthrough": {"fixed": false}}
        }
    }))
    .unwrap();
    let ctx = Context {
        key: "user-4242".to_string(),
        attributes: [("country".to_string(), AttrValue::Str("US".into())),
                     ("plan".to_string(), AttrValue::Str("pro".into()))]
            .into_iter()
            .collect::<HashMap<_, _>>(),
    };
    // Warm up, then time N evaluations (rollout path: hash + bucket + serve).
    for _ in 0..1000 {
        std::hint::black_box(evaluate(&config, "new-checkout", &ctx));
    }
    let n = 200_000u64;
    let t = Instant::now();
    for _ in 0..n {
        std::hint::black_box(evaluate(&config, "new-checkout", &ctx));
    }
    let per = t.elapsed().as_nanos() as f64 / n as f64;
    println!("native evaluate: {per:.0} ns/eval ({} evals/sec)", (1e9 / per) as u64);

    let t = Instant::now();
    for i in 0..n {
        std::hint::black_box(bucket("new-checkout", &format!("user-{i}")));
    }
    let per = t.elapsed().as_nanos() as f64 / n as f64;
    println!("native bucket:   {per:.0} ns/hash ({:.1}M hashes/sec)", 1e3 / per);
}
