// Zero-dependency static server for the demo (correct MIME types included).
// Run from the repo root: node demo/server.mjs [port]   (default 8081)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const root = join(import.meta.dirname, "..");
const port = Number(process.argv[2]) || 8081;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname))
      .replace(/^[/\\]+/, "");
    if (path === "" || /[/\\]$/.test(path)) path += "index.html";
    const file = join(root, path);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(port, () => console.log(`demo at http://localhost:${port}/demo/`));
