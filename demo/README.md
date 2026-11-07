# Demo app

A tiny page that consumes the SDK exactly like a customer app: it polls
`/sdk/v1/config` into the real WASM Engine and renders `demo-banner` (bool)
and `demo-cta` (string). Flip either flag in the dashboard and this page
changes within one poll interval (2s).

```powershell
# one-time: build the web-target WASM the page loads
wasm-pack build crates/switchyard-wasm --target web --out-dir ../../sdk/js/pkg-web

# serve the demo (127.0.0.1 only; exposes just demo/ and sdk/js/pkg-web/)
node demo/server.mjs
```

Open `http://localhost:8081/demo/`, paste a **development** SDK key
(dashboard → SDK Keys) into the form, and press Connect. The key is kept in
this tab's `sessionStorage` only (so a reload reconnects with one click) and
is never read from or written to the URL — there is no `?key=` parameter.
Toggle `demo-banner` off in the dashboard → the banner vanishes here
within ~2 seconds.
