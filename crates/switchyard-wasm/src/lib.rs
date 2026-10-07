//! `switchyard-wasm`: wasm-bindgen wrapper around `switchyard-core` (SPEC.md section 5).
//!
//! The `Engine` holds the parsed config so evaluations never reparse JSON.
//! `load` validates before swapping; `evaluate` never panics across the boundary.

use switchyard_core::{EnvConfig, evaluate, validate};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Engine {
    config: Option<EnvConfig>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { config: None }
    }

    /// Validate `config_json` and, only if valid, replace the active config.
    /// Returns the new environment version.
    pub fn load(&mut self, config_json: &str) -> Result<u64, JsError> {
        let config: EnvConfig = serde_json::from_str(config_json)
            .map_err(|e| JsError::new(&format!("invalid config JSON: {e}")))?;
        let errors = validate(&config);
        if !errors.is_empty() {
            let detail = serde_json::to_string(&errors).unwrap_or_else(|_| "[]".to_string());
            return Err(JsError::new(&format!("config failed validation: {detail}")));
        }
        let version = config.version;
        self.config = Some(config);
        Ok(version)
    }

    pub fn version(&self) -> Option<u64> {
        self.config.as_ref().map(|c| c.version)
    }

    /// Evaluate one flag. Always returns an `Evaluation` JSON string and never
    /// throws: a missing config or malformed context yields `ERROR`.
    pub fn evaluate(&self, flag_key: &str, context_json: &str) -> String {
        let err = |msg: &str| {
            let _ = msg;
            String::from(r#"{"value":null,"reason":"ERROR","ruleId":null}"#)
        };
        let config = match &self.config {
            Some(c) => c,
            None => return err("no config loaded"),
        };
        let ctx = match serde_json::from_str(context_json) {
            Ok(c) => c,
            Err(_) => return err("bad context"),
        };
        let eval = evaluate(config, flag_key, &ctx);
        serde_json::to_string(&eval).unwrap_or_else(|_| err("serialize"))
    }
}
