# Glossary

## WASM
- **Crate**: a Rust package of code — one library or program with its own name and version file (`Cargo.toml`).
- **wasm-pack**: the tool that compiles a Rust crate into WebAssembly and wraps it so JavaScript can load it.
- **Target (`wasm32-unknown-unknown`)**: the WebAssembly build output — Rust's way of saying "compile this so it runs inside a browser or Node, not Windows directly".
- **wasm-bindgen**: the bridge library that lets Rust functions be called from JavaScript.
- **Engine**: the object (Rust struct + JS class) that holds a parsed flag config in memory so evaluations don't reparse JSON.
