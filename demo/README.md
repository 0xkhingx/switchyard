# Demo app

A tiny page that consumes the SDK exactly like a customer app: it polls
`/sdk/v1/config` into the real WASM Engine and renders `demo-banner` (bool)
and `demo-cta` (string). Flip either flag in the dashboard and this page
changes within one poll interval (2s).

```powershell
# one-time: build the web-target WASM the page loads
wasm-pack build crates/switchyard-wasm --target web --out-dir ../../sdk/js/pkg-web

# serve the repo (demo at /demo/)
node demo/server.mjs
```

Open `http://localhost:8081/demo/`, paste a **development** SDK key
(dashboard → SDK Keys), and press Connect. The key lives in page memory
only. Toggle `demo-banner` off in the dashboard → the banner vanishes here
within ~2 seconds.
