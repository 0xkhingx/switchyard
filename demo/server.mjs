// Zero-dependency static server for the demo (correct MIME types included).
// Run from the repo root: node demo/server.mjs [port]   (default 8081)
//
// Serves ONLY the demo page and the web-target WASM build it imports
// (never the repo root, so .git, .env etc. are unreachable), binds to
// 127.0.0.1, and rejects any path that resolves outside an allowed root.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const port = Number(process.argv[2]) || 8081;
const host = "127.0.0.1";

// URL prefix -> directory on disk. app.mjs imports ../sdk/js/pkg-web/*.
const ROOTS = [
  ["/demo/", resolve(repo, "demo")],
  ["/sdk/js/pkg-web/", resolve(repo, "sdk", "js", "pkg-web")],
];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
};

function send(res, status, body = "") {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

// Map a request path to a file inside an allowed root, or null.
function resolveFile(rawPath) {
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null; // malformed percent-encoding
  }
  // Reject traversal, backslashes and NULs outright (also catches %2e%2e, %5c).
  if (path.includes("\0") || path.includes("\\") || path.split("/").includes("..")) return null;
  for (const [prefix, dir] of ROOTS) {
    if (!path.startsWith(prefix)) continue;
    let rel = path.slice(prefix.length);
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const file = resolve(dir, rel);
    // Defense in depth: the resolved file must stay under its root.
    if (file !== dir && !file.startsWith(dir + sep)) return null;
    // No dotfiles anywhere below the root.
    if (rel.split("/").some((seg) => seg.startsWith("."))) return null;
    return file;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
  let pathname;
  try {
    pathname = new URL(req.url, "http://x").pathname;
  } catch {
    return send(res, 400, "bad request");
  }
  if (pathname === "/" || pathname === "/demo") {
    res.writeHead(302, { Location: "/demo/" });
    return res.end();
  }
  const file = resolveFile(pathname);
  if (!file) return send(res, 403, "forbidden");
  try {
    if (!(await stat(file)).isFile()) return send(res, 404, "not found");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    send(res, 404, "not found");
  }
});

server.listen(port, host, () => console.log(`demo at http://localhost:${port}/demo/ (bound to ${host})`));
