use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn evaluate() -> String {
    // M0 spike: hardcoded result. Real Engine lands in M3.
    String::from(r#"{"value":true,"reason":"RULE_MATCH","ruleId":"r1"}"#)
}
