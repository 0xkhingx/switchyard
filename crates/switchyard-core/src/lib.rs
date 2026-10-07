//! `switchyard-core`: deterministic flag evaluator shared by the server and the WASM SDK.
//!
//! No I/O, no threads, no clocks, no randomness — so it compiles to WASM
//! unchanged and is trivially testable. Implements SPEC.md section 3.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// Types (SPEC.md section 3.1)
// ---------------------------------------------------------------------------

/// A value a flag can serve: boolean or string, matching the flag's `type`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum Variant {
    Bool(bool),
    Str(String),
}

/// An attribute value supplied by the calling app: boolean, number or string.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum AttrValue {
    Bool(bool),
    Num(f64),
    Str(String),
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FlagType {
    Bool,
    String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Equals,
    NotEquals,
    In,
    NotIn,
    Contains,
    StartsWith,
    EndsWith,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Condition {
    pub attribute: String,
    pub op: Op,
    pub values: Vec<AttrValue>,
}

/// One slice of a rollout, in basis points (1% = 100).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WeightedVariant {
    pub value: Variant,
    pub weight: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Serve {
    Fixed(Variant),
    Rollout(Vec<WeightedVariant>),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Rule {
    pub id: String,
    pub conditions: Vec<Condition>,
    pub serve: Serve,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlagConfig {
    #[serde(rename = "type")]
    pub kind: FlagType,
    pub enabled: bool,
    pub off_value: Variant,
    pub rules: Vec<Rule>,
    pub fallthrough: Serve,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct EnvConfig {
    pub version: u64,
    pub flags: HashMap<String, FlagConfig>,
}

/// What the app passes in: a user key plus string-keyed attributes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Context {
    pub key: String,
    pub attributes: HashMap<String, AttrValue>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Reason {
    Off,
    RuleMatch,
    Fallthrough,
    FlagNotFound,
    Error,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub value: Option<Variant>,
    pub reason: Reason,
    pub rule_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Bucketing (SPEC.md section 3.4)
// ---------------------------------------------------------------------------

/// murmur3_x86_32 with seed 0, ported from `spec/reference_eval.py`.
/// Hand-rolled (instead of a crate) so the frozen hash has zero dependency
/// surface that could silently change variants.
pub fn murmur3_x86_32(data: &[u8], seed: u32) -> u32 {
    const C1: u32 = 0xCC9E2D51;
    const C2: u32 = 0x1B873593;
    let mut h = seed;
    let n = data.len();
    let nblocks = n / 4;
    for i in 0..nblocks {
        let mut k = u32::from_le_bytes([
            data[4 * i],
            data[4 * i + 1],
            data[4 * i + 2],
            data[4 * i + 3],
        ]);
        k = k.wrapping_mul(C1);
        k = k.rotate_left(15);
        k = k.wrapping_mul(C2);
        h ^= k;
        h = h.rotate_left(13);
        h = h.wrapping_mul(5).wrapping_add(0xE6546B64);
    }
    let tail = &data[nblocks * 4..];
    let mut k: u32 = 0;
    if tail.len() >= 3 {
        k ^= (tail[2] as u32) << 16;
    }
    if tail.len() >= 2 {
        k ^= (tail[1] as u32) << 8;
    }
    if !tail.is_empty() {
        k ^= tail[0] as u32;
        k = k.wrapping_mul(C1);
        k = k.rotate_left(15);
        k = k.wrapping_mul(C2);
        h ^= k;
    }
    h ^= n as u32;
    h ^= h >> 16;
    h = h.wrapping_mul(0x85EBCA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2AE35);
    h ^= h >> 16;
    h
}

/// `bucket = murmur3_x86_32("flagKey:contextKey") % 10_000`, range 0..=9999.
pub fn bucket(flag_key: &str, context_key: &str) -> u32 {
    let input = format!("{flag_key}:{context_key}");
    murmur3_x86_32(input.as_bytes(), 0) % 10_000
}

// ---------------------------------------------------------------------------
// Evaluation (SPEC.md sections 3.2 and 3.3)
// ---------------------------------------------------------------------------

/// Evaluate one flag for one context. Pure function of its inputs.
pub fn evaluate(config: &EnvConfig, flag_key: &str, ctx: &Context) -> Evaluation {
    let flag = match config.flags.get(flag_key) {
        None => {
            return Evaluation {
                value: None,
                reason: Reason::FlagNotFound,
                rule_id: None,
            }
        }
        Some(f) => f,
    };
    if !flag.enabled {
        return Evaluation {
            value: Some(flag.off_value.clone()),
            reason: Reason::Off,
            rule_id: None,
        };
    }
    for rule in &flag.rules {
        // AND across conditions; an empty condition list matches everyone.
        if rule.conditions.iter().all(|c| cond_match(c, ctx)) {
            return serve(
                flag,
                flag_key,
                &rule.serve,
                ctx,
                Reason::RuleMatch,
                Some(rule.id.clone()),
            );
        }
    }
    serve(flag, flag_key, &flag.fallthrough, ctx, Reason::Fallthrough, None)
}

fn serve(
    flag: &FlagConfig,
    flag_key: &str,
    s: &Serve,
    ctx: &Context,
    reason: Reason,
    rule_id: Option<String>,
) -> Evaluation {
    match s {
        Serve::Fixed(v) => Evaluation {
            value: Some(v.clone()),
            reason,
            rule_id,
        },
        Serve::Rollout(buckets) => {
            if ctx.key.is_empty() {
                return Evaluation {
                    value: Some(flag.off_value.clone()),
                    reason: Reason::Error,
                    rule_id: None,
                };
            }
            let b = bucket(flag_key, &ctx.key);
            let mut cumulative: u32 = 0;
            for w in buckets {
                cumulative += w.weight;
                if b < cumulative {
                    return Evaluation {
                        value: Some(w.value.clone()),
                        reason,
                        rule_id,
                    };
                }
            }
            // Unreachable when weights sum to 10_000 (enforced by validation).
            // Defensive: never panic, report ERROR with the off value.
            Evaluation {
                value: Some(flag.off_value.clone()),
                reason: Reason::Error,
                rule_id: None,
            }
        }
    }
}

fn cond_match(cond: &Condition, ctx: &Context) -> bool {
    // The special attribute `key` refers to the context key.
    // A missing attribute never matches, for every operator.
    let val: &AttrValue;
    let owned;
    if cond.attribute == "key" {
        owned = AttrValue::Str(ctx.key.clone());
        val = &owned;
    } else {
        match ctx.attributes.get(&cond.attribute) {
            None => return false,
            Some(v) => val = v,
        }
    }
    match cond.op {
        // Equality is type-strict via the derived PartialEq on the enum:
        // Bool(1-ish) never equals Str("1") because the variants differ.
        Op::Equals => cond.values.first().map(|v| v == val).unwrap_or(false),
        Op::NotEquals => cond.values.first().map(|v| v != val).unwrap_or(false),
        Op::In => cond.values.iter().any(|v| v == val),
        Op::NotIn => !cond.values.iter().any(|v| v == val),
        // String operators are case-sensitive and match only strings.
        Op::Contains => match (val, cond.values.first()) {
            (AttrValue::Str(hay), Some(AttrValue::Str(needle))) => hay.contains(needle.as_str()),
            _ => false,
        },
        Op::StartsWith => match (val, cond.values.first()) {
            (AttrValue::Str(hay), Some(AttrValue::Str(prefix))) => {
                hay.starts_with(prefix.as_str())
            }
            _ => false,
        },
        Op::EndsWith => match (val, cond.values.first()) {
            (AttrValue::Str(hay), Some(AttrValue::Str(suffix))) => {
                hay.ends_with(suffix.as_str())
            }
            _ => false,
        },
    }
}

// ---------------------------------------------------------------------------
// Validation (SPEC.md section 3.5)
// ---------------------------------------------------------------------------

/// One validation failure, carrying a JSON-pointer-style path.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ValidationError {
    pub path: String,
    pub message: String,
}

fn flag_key_valid(k: &str) -> bool {
    let b = k.as_bytes();
    if b.is_empty() || b.len() > 64 {
        return false;
    }
    if !matches!(b[0], b'a'..=b'z' | b'0'..=b'9') {
        return false;
    }
    b.iter()
        .all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

fn variant_matches(kind: FlagType, v: &Variant) -> bool {
    matches!(
        (kind, v),
        (FlagType::Bool, Variant::Bool(_)) | (FlagType::String, Variant::Str(_))
    )
}

fn check_variant(
    out: &mut Vec<ValidationError>,
    path: String,
    kind: FlagType,
    v: &Variant,
) {
    if !variant_matches(kind, v) {
        out.push(ValidationError {
            path,
            message: "variant type must match the flag type".to_string(),
        });
        return;
    }
    if let Variant::Str(s) = v {
        if s.len() > 256 {
            out.push(ValidationError {
                path,
                message: "string variant must be at most 256 bytes".to_string(),
            });
        }
    }
}

fn check_serve(
    out: &mut Vec<ValidationError>,
    base: String,
    kind: FlagType,
    s: &Serve,
) {
    match s {
        Serve::Fixed(v) => check_variant(out, format!("{base}/fixed"), kind, v),
        Serve::Rollout(entries) => {
            if entries.is_empty() {
                out.push(ValidationError {
                    path: format!("{base}/rollout"),
                    message: "rollout must have at least 1 entry".to_string(),
                });
                return;
            }
            let mut total: u32 = 0;
            for (i, e) in entries.iter().enumerate() {
                if e.weight > 10_000 {
                    out.push(ValidationError {
                        path: format!("{base}/rollout/{i}/weight"),
                        message: "weight must be 0 to 10000".to_string(),
                    });
                }
                total += e.weight;
                check_variant(out, format!("{base}/rollout/{i}/value"), kind, &e.value);
            }
            if total != 10_000 {
                out.push(ValidationError {
                    path: format!("{base}/rollout"),
                    message: "rollout weights must sum to exactly 10000".to_string(),
                });
            }
        }
    }
}

/// Validate a whole environment config, returning every problem found.
pub fn validate(config: &EnvConfig) -> Vec<ValidationError> {
    let mut out = Vec::new();
    for (key, flag) in &config.flags {
        let fbase = format!("/flags/{key}");
        if !flag_key_valid(key) {
            out.push(ValidationError {
                path: fbase.clone(),
                message: "flag key must match ^[a-z0-9][a-z0-9._-]{0,63}$".to_string(),
            });
        }
        if flag.rules.len() > 50 {
            out.push(ValidationError {
                path: format!("{fbase}/rules"),
                message: "at most 50 rules per flag".to_string(),
            });
        }
        let mut seen_ids = HashSet::new();
        for (i, rule) in flag.rules.iter().enumerate() {
            let rbase = format!("{fbase}/rules/{i}");
            let id_len = rule.id.chars().count();
            if id_len < 1 || id_len > 32 {
                out.push(ValidationError {
                    path: format!("{rbase}/id"),
                    message: "rule id must be 1 to 32 characters".to_string(),
                });
            }
            if !seen_ids.insert(rule.id.clone()) {
                out.push(ValidationError {
                    path: format!("{rbase}/id"),
                    message: "rule ids must be unique within a flag".to_string(),
                });
            }
            if rule.conditions.len() > 20 {
                out.push(ValidationError {
                    path: format!("{rbase}/conditions"),
                    message: "at most 20 conditions per rule".to_string(),
                });
            }
            for (j, cond) in rule.conditions.iter().enumerate() {
                let cbase = format!("{rbase}/conditions/{j}");
                match cond.op {
                    Op::In | Op::NotIn => {
                        if cond.values.is_empty() || cond.values.len() > 100 {
                            out.push(ValidationError {
                                path: format!("{cbase}/values"),
                                message: "in/notIn need 1 to 100 values".to_string(),
                            });
                        }
                    }
                    _ => {
                        if cond.values.len() != 1 {
                            out.push(ValidationError {
                                path: format!("{cbase}/values"),
                                message: "this operator needs exactly 1 value".to_string(),
                            });
                        }
                    }
                }
                match cond.op {
                    Op::Contains | Op::StartsWith | Op::EndsWith => {
                        if let Some(first) = cond.values.first() {
                            if !matches!(first, AttrValue::Str(_)) {
                                out.push(ValidationError {
                                    path: format!("{cbase}/values/0"),
                                    message: "string operators need a string value".to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
            check_serve(&mut out, format!("{rbase}/serve"), flag.kind, &rule.serve);
        }
        check_variant(&mut out, format!("{fbase}/offValue"), flag.kind, &flag.off_value);
        check_serve(
            &mut out,
            format!("{fbase}/fallthrough"),
            flag.kind,
            &flag.fallthrough,
        );
    }
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    fn ctx(key: &str, attrs: &[(&str, AttrValue)]) -> Context {
        Context {
            key: key.to_string(),
            attributes: attrs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }

    fn section_21_config() -> EnvConfig {
        serde_json::from_value(serde_json::json!({
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
                    "fallthrough": {"fixed": false}},
                "banner-text": {
                    "type": "string", "enabled": false, "offValue": "Welcome",
                    "rules": [], "fallthrough": {"fixed": "Spring sale"}}
            }
        }))
        .unwrap()
    }

    #[test]
    fn hash_vectors() {
        assert_eq!(murmur3_x86_32(b"", 0), 0x00000000);
        assert_eq!(murmur3_x86_32(b"hello", 0), 0x248BFA47);
        assert_eq!(
            murmur3_x86_32(b"The quick brown fox jumps over the lazy dog", 0),
            0x2E4FF723
        );
    }

    #[test]
    fn bucket_vectors() {
        let cases = [
            ("u-1", 9373),
            ("u-2", 322),
            ("u-3", 6066),
            ("u-4", 7192),
            ("u-5", 1826),
            ("u-6", 8222),
            ("u-7", 6635),
            ("u-8", 227),
        ];
        for (k, b) in cases {
            assert_eq!(bucket("new-checkout", k), b, "bucket for {k}");
        }
    }

    #[test]
    fn evaluation_vectors() {
        let cfg = section_21_config();
        // r1 fixed match
        let e = evaluate(
            &cfg,
            "new-checkout",
            &ctx("u-1", &[("country", AttrValue::Str("NG".into()))]),
        );
        assert_eq!(
            e,
            Evaluation {
                value: Some(Variant::Bool(true)),
                reason: Reason::RuleMatch,
                rule_id: Some("r1".into())
            }
        );
        // r2 rollout in (bucket 322 < 2000)
        let e = evaluate(
            &cfg,
            "new-checkout",
            &ctx(
                "u-2",
                &[
                    ("country", AttrValue::Str("US".into())),
                    ("plan", AttrValue::Str("pro".into())),
                ],
            ),
        );
        assert_eq!(e.reason, Reason::RuleMatch);
        assert_eq!(e.rule_id, Some("r2".into()));
        assert_eq!(e.value, Some(Variant::Bool(true)));
        // r2 rollout out (bucket 6066 >= 2000)
        let e = evaluate(
            &cfg,
            "new-checkout",
            &ctx(
                "u-3",
                &[
                    ("country", AttrValue::Str("US".into())),
                    ("plan", AttrValue::Str("pro".into())),
                ],
            ),
        );
        assert_eq!(e.value, Some(Variant::Bool(false)));
        assert_eq!(e.reason, Reason::RuleMatch);
        // fallthrough
        let e = evaluate(
            &cfg,
            "new-checkout",
            &ctx(
                "u-4",
                &[
                    ("country", AttrValue::Str("US".into())),
                    ("plan", AttrValue::Str("free".into())),
                ],
            ),
        );
        assert_eq!(
            e,
            Evaluation {
                value: Some(Variant::Bool(false)),
                reason: Reason::Fallthrough,
                rule_id: None
            }
        );
        // rollout with empty key -> ERROR with off value
        let e = evaluate(
            &cfg,
            "new-checkout",
            &ctx(
                "",
                &[
                    ("country", AttrValue::Str("US".into())),
                    ("plan", AttrValue::Str("pro".into())),
                ],
            ),
        );
        assert_eq!(e.reason, Reason::Error);
        assert_eq!(e.value, Some(Variant::Bool(false)));
        // disabled flag -> OFF with off value
        let e = evaluate(&cfg, "banner-text", &ctx("u-1", &[]));
        assert_eq!(e.reason, Reason::Off);
        assert_eq!(e.value, Some(Variant::Str("Welcome".into())));
        // unknown flag -> FLAG_NOT_FOUND with null value
        let e = evaluate(&cfg, "nope", &ctx("u-1", &[]));
        assert_eq!(
            e,
            Evaluation {
                value: None,
                reason: Reason::FlagNotFound,
                rule_id: None
            }
        );
    }

    #[test]
    fn missing_attribute_never_matches() {
        let cond = |op| Condition {
            attribute: "plan".into(),
            op,
            values: vec![AttrValue::Str("pro".into())],
        };
        let empty = ctx("u-1", &[]);
        for op in [
            Op::Equals,
            Op::NotEquals,
            Op::In,
            Op::NotIn,
            Op::Contains,
            Op::StartsWith,
            Op::EndsWith,
        ] {
            assert!(!cond_match(&cond(op), &empty), "op {op:?} must not match");
        }
        // ...but the same conditions match when the attribute is present.
        let pro = ctx("u-1", &[("plan", AttrValue::Str("pro".into()))]);
        assert!(cond_match(&cond(Op::Equals), &pro));
        assert!(cond_match(&cond(Op::NotEquals), &ctx("u-1", &[("plan", AttrValue::Str("free".into()))])));
        assert!(cond_match(&cond(Op::NotIn), &ctx("u-1", &[("plan", AttrValue::Str("free".into()))])));
    }

    #[test]
    fn equality_is_type_strict() {
        let num_one = ctx("u-1", &[("n", AttrValue::Num(1.0))]);
        let str_one = ctx("u-1", &[("n", AttrValue::Str("1".into()))]);
        let eq_num = Condition {
            attribute: "n".into(),
            op: Op::Equals,
            values: vec![AttrValue::Num(1.0)],
        };
        assert!(cond_match(&eq_num, &num_one));
        assert!(!cond_match(&eq_num, &str_one));
        // bool true is not number 1
        assert!(!cond_match(
            &eq_num,
            &ctx("u-1", &[("n", AttrValue::Bool(true))])
        ));
    }

    #[test]
    fn string_operators_need_strings() {
        let c = Condition {
            attribute: "city".into(),
            op: Op::Contains,
            values: vec![AttrValue::Str("Lag".into())],
        };
        assert!(cond_match(&c, &ctx("u-1", &[("city", AttrValue::Str("Lagos".into()))])));
        assert!(!cond_match(&c, &ctx("u-1", &[("city", AttrValue::Num(3.0))])));
        // case-sensitive
        let c2 = Condition {
            attribute: "city".into(),
            op: Op::StartsWith,
            values: vec![AttrValue::Str("lag".into())],
        };
        assert!(!cond_match(&c2, &ctx("u-1", &[("city", AttrValue::Str("Lagos".into()))])));
    }

    #[test]
    fn key_attribute_refers_to_context_key() {
        let c = Condition {
            attribute: "key".into(),
            op: Op::Equals,
            values: vec![AttrValue::Str("u-9".into())],
        };
        assert!(cond_match(&c, &ctx("u-9", &[])));
        assert!(!cond_match(&c, &ctx("u-10", &[])));
    }

    #[test]
    fn empty_conditions_match_everyone() {
        let cfg: EnvConfig = serde_json::from_value(serde_json::json!({
            "version": 1,
            "flags": {"f": {"type": "bool", "enabled": true, "offValue": false,
                "rules": [{"id": "all", "conditions": [], "serve": {"fixed": true}}],
                "fallthrough": {"fixed": false}}}
        }))
        .unwrap();
        let e = evaluate(&cfg, "f", &ctx("anyone", &[]));
        assert_eq!(e.value, Some(Variant::Bool(true)));
        assert_eq!(e.rule_id, Some("all".into()));
    }

    #[test]
    fn validation_accepts_good_config() {
        assert!(validate(&section_21_config()).is_empty());
    }

    #[test]
    fn validation_catches_bad_config() {
        let bad: EnvConfig = serde_json::from_value(serde_json::json!({
            "version": 1,
            "flags": {
                "Bad Key!": {"type": "bool", "enabled": true, "offValue": "oops",
                    "rules": [
                        {"id": "dup", "conditions": [
                            {"attribute": "a", "op": "equals", "values": []}],
                         "serve": {"rollout": [
                            {"value": true, "weight": 5000},
                            {"value": false, "weight": 4000}]}},
                        {"id": "dup", "conditions": [
                            {"attribute": "b", "op": "contains", "values": [42]}],
                         "serve": {"fixed": true}}],
                    "fallthrough": {"fixed": false}}
            }
        }))
        .unwrap();
        let errs = validate(&bad);
        let msgs: Vec<&str> = errs.iter().map(|e| e.message.as_str()).collect();
        assert!(msgs.iter().any(|m| m.contains("flag key")), "{msgs:?}");
        assert!(msgs.iter().any(|m| m.contains("match the flag type")), "{msgs:?}");
        assert!(msgs.iter().any(|m| m.contains("unique")), "{msgs:?}");
        assert!(msgs.iter().any(|m| m.contains("exactly 1 value")), "{msgs:?}");
        assert!(msgs.iter().any(|m| m.contains("sum to exactly 10000")), "{msgs:?}");
        assert!(msgs.iter().any(|m| m.contains("string value")), "{msgs:?}");
        assert!(errs.iter().all(|e| e.path.starts_with("/flags/")));
    }

    #[test]
    fn determinism_and_partition() {
        // Same inputs always give the same bucket and the same evaluation.
        let cfg = section_21_config();
        let c = ctx("u-3", &[("plan", AttrValue::Str("pro".into()))]);
        let first = evaluate(&cfg, "new-checkout", &c);
        for _ in 0..50 {
            assert_eq!(evaluate(&cfg, "new-checkout", &c), first);
            assert_eq!(bucket("new-checkout", "u-3"), 6066);
        }
        // A 2000/8000 rollout partitions the whole 0..10000 bucket space.
        let mut inside = 0;
        for b in 0..10_000u32 {
            let v = if b < 2000 { true } else { false };
            if v {
                inside += 1;
            }
        }
        assert_eq!(inside, 2000);
    }

    #[test]
    fn distribution_and_stickiness() {
        // Mirrors spec 3.6: 100k keys, 2000bp bucket lands 19-21%,
        // and growing the first weight 2000 -> 3000 keeps everyone included.
        let (mut count, mut violations) = (0u32, 0u32);
        for i in 0..100_000u32 {
            let b = bucket("new-checkout", &format!("user-{i}"));
            if b < 2000 {
                count += 1;
            }
            if b < 2000 && !(b < 3000) {
                violations += 1;
            }
        }
        let share = count as f64 / 100_000.0;
        assert!((0.19..=0.21).contains(&share), "share {share}");
        assert_eq!(violations, 0);
    }

    // JSON vectors committed under spec/vectors (generated by spec/gen_vectors.py).
    #[test]
    fn json_vectors() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/vectors");
        let read = |name: &str| {
            std::fs::read_to_string(format!("{dir}/{name}")).expect(name)
        };

        #[derive(Deserialize)]
        struct HashVec {
            input: String,
            hash: u32,
        }
        let hashes: Vec<HashVec> = serde_json::from_str(&read("hash.json")).unwrap();
        for v in hashes {
            assert_eq!(murmur3_x86_32(v.input.as_bytes(), 0), v.hash);
        }

        #[derive(Deserialize)]
        struct BucketFile {
            flag: String,
            vectors: Vec<BucketVec>,
        }
        #[derive(Deserialize)]
        struct BucketVec {
            key: String,
            bucket: u32,
        }
        let bf: BucketFile = serde_json::from_str(&read("buckets.json")).unwrap();
        for v in bf.vectors {
            assert_eq!(bucket(&bf.flag, &v.key), v.bucket);
        }

        #[derive(Deserialize)]
        struct EvalFile {
            config: EnvConfig,
            cases: Vec<EvalCase>,
        }
        #[derive(Deserialize)]
        struct EvalCase {
            flag: String,
            context: Context,
            expected: Expected,
        }
        #[derive(Deserialize)]
        struct Expected {
            value: Option<Variant>,
            reason: String,
            #[serde(rename = "ruleId")]
            rule_id: Option<String>,
        }
        let ef: EvalFile = serde_json::from_str(&read("evaluations.json")).unwrap();
        assert!(validate(&ef.config).is_empty());
        for c in ef.cases {
            let got = evaluate(&ef.config, &c.flag, &c.context);
            let want_reason = match c.expected.reason.as_str() {
                "OFF" => Reason::Off,
                "RULE_MATCH" => Reason::RuleMatch,
                "FALLTHROUGH" => Reason::Fallthrough,
                "FLAG_NOT_FOUND" => Reason::FlagNotFound,
                "ERROR" => Reason::Error,
                other => panic!("bad reason {other}"),
            };
            assert_eq!(got.value, c.expected.value, "value {}", c.flag);
            assert_eq!(got.reason, want_reason, "reason {}", c.flag);
            assert_eq!(got.rule_id, c.expected.rule_id, "rule {}", c.flag);
        }

        #[derive(Deserialize)]
        struct DistFile {
            flag: String,
            total: u32,
            prefix: String,
            threshold: u32,
            min_share: f64,
            max_share: f64,
            sticky_from: u32,
            sticky_to: u32,
        }
        let df: DistFile = serde_json::from_str(&read("distribution.json")).unwrap();
        let (mut count, mut violations) = (0u32, 0u32);
        for i in 0..df.total {
            let b = bucket(&df.flag, &format!("{}{}", df.prefix, i));
            if b < df.threshold {
                count += 1;
            }
            if b < df.sticky_from && !(b < df.sticky_to) {
                violations += 1;
            }
        }
        let share = count as f64 / df.total as f64;
        assert!((df.min_share..=df.max_share).contains(&share), "share {share}");
        assert_eq!(violations, 0);
    }
}
