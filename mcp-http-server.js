/* FableCut multi-project remote MCP service (Streamable HTTP, Node stdlib only). */
"use strict";

const http = require("http");

const { READ_SCOPE, WRITE_SCOPE } = require("./mcp/core");
const { LATEST_PROTOCOL, SUPPORTED_PROTOCOLS, protocolError } = require("./mcp/protocol");
const { createRuntime } = require("./mcp/runtime");
const { ownerKey } = require("./mcp/storage");

const APP_DIR = __dirname;
const HOST = process.env.FABLECUT_MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.FABLECUT_MCP_PORT || 7788);
const PUBLIC_URL = (process.env.FABLECUT_MCP_PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/$/, "");
const publicUrl = new URL(PUBLIC_URL);
if (publicUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname))
  throw new Error("FABLECUT_MCP_PUBLIC_URL must use HTTPS except on loopback");
const MCP_URL = `${PUBLIC_URL}/mcp`;
const runtime = createRuntime(APP_DIR, {
  mediaReference: "src",
  protocol: { disabledTools: ["fablecut_analyze_reference", "fablecut_status"] },
});
const issuer = "urn:fablecut:http";
const subject = "shared";
const identity = { issuer, subject, ownerKey: ownerKey(issuer, subject),
  scopes: new Set([READ_SCOPE, WRITE_SCOPE]), local: true };

const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1", HOST.toLowerCase()]);
allowedHosts.add(publicUrl.hostname.toLowerCase());
for (const item of (process.env.FABLECUT_ALLOWED_HOSTS || "").split(",")) if (item.trim()) allowedHosts.add(item.trim().toLowerCase());
const allowedOrigins = new Set((process.env.FABLECUT_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean));
const buckets = new Map();

function hostAllowed(value) {
  if (!value) return false;
  const host = value.replace(/^(\[[^\]]*\]|[^:]+)(:\d+)?$/, "$1").toLowerCase();
  return allowedHosts.has(host);
}

function requestAllowed(req) {
  if (!hostAllowed(req.headers.host)) return false;
  if (!req.headers.origin) return true;
  return allowedOrigins.has(req.headers.origin) || req.headers.origin === PUBLIC_URL;
}

function sendJSON(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function readBody(req) {
  const max = Number(process.env.FABLECUT_MAX_MCP_BODY_BYTES || 8 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) { reject(Object.assign(new Error("request body too large"), { status: 413 })); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function rateAllowed(identity) {
  const limit = Number(process.env.FABLECUT_MCP_REQUESTS_PER_MINUTE || 120);
  const minute = Math.floor(Date.now() / 60_000);
  if (buckets.size > 10_000) for (const [key, value] of buckets) if (value.minute < minute - 1) buckets.delete(key);
  const current = buckets.get(identity.ownerKey);
  if (!current || current.minute !== minute) { buckets.set(identity.ownerKey, { minute, count: 1 }); return true; }
  current.count++;
  return current.count <= limit;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now(); let method = null; let tool = null; let projectId = null; let outcome = "error";
  try {
    if (!requestAllowed(req)) return sendJSON(res, 403, { error: "forbidden Host or Origin" });
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") {
      outcome = "ok"; return sendJSON(res, 200, { ok: true, service: "fablecut-mcp", version: "2.0.0" });
    }
    if (url.pathname !== "/mcp") return sendJSON(res, 404, { error: "not found" });
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }
    const accept = req.headers.accept || "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
      return sendJSON(res, 406, { error: "Accept must include application/json and text/event-stream" });
    if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json"))
      return sendJSON(res, 415, { error: "Content-Type must be application/json" });
    if (!rateAllowed(identity)) return sendJSON(res, 429, { error: "rate limit exceeded" }, { "Retry-After": "60" });
    const raw = await readBody(req);
    let message;
    try { message = JSON.parse(raw.toString("utf8")); } catch { return sendJSON(res, 400, protocolError(null, -32700, "Parse error")); }
    method = message.method; tool = message.method === "tools/call" ? message.params?.name : null;
    projectId = message.params?.arguments?.projectId || null;
    const version = req.headers["mcp-protocol-version"];
    if (message.method !== "initialize" && !SUPPORTED_PROTOCOLS.has(version))
      return sendJSON(res, 400, protocolError(message.id, -32600, `Unsupported MCP-Protocol-Version: ${version}`));
    const reply = await runtime.protocol.handle(message, identity);
    outcome = reply?.result?.isError ? "tool_error" : "ok";
    if (!reply) { res.writeHead(202); return res.end(); }
    return sendJSON(res, 200, reply, { "MCP-Protocol-Version": version || reply.result?.protocolVersion || LATEST_PROTOCOL });
  } catch (error) {
    return sendJSON(res, error.status || 500, { error: error.status ? error.message : "internal server error" });
  } finally {
    const record = { time: new Date().toISOString(), method, tool, projectId,
      subject: identity?.ownerKey?.slice(0, 12), outcome, durationMs: Date.now() - started };
    process.stderr.write(JSON.stringify(record) + "\n");
  }
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`FableCut MCP listening on ${HOST}:${PORT}; public resource ${MCP_URL}\n`);
});
