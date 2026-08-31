/* FableCut multi-project local MCP adapter (stdio, Node stdlib only). */
"use strict";

const os = require("os");

const { READ_SCOPE, WRITE_SCOPE } = require("./mcp/core");
const { createRuntime } = require("./mcp/runtime");
const { ownerKey } = require("./mcp/storage");

const runtime = createRuntime(__dirname);
const subject = process.env.FABLECUT_LOCAL_USER_ID || `local:${os.userInfo().username}`;
const identity = {
  issuer: "urn:fablecut:local",
  subject,
  ownerKey: ownerKey("urn:fablecut:local", subject),
  scopes: new Set([READ_SCOPE, WRITE_SCOPE]),
  local: true,
};

function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }

let buffer = "";
let pending = 0;
let stdinClosed = false;

async function dispatch(message) {
  pending++;
  try {
    const response = await runtime.protocol.handle(message, identity);
    if (response) send(response);
  } catch (error) {
    if (message?.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error" } });
  } finally {
    pending--;
    if (stdinClosed && pending === 0) process.exit(0);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { dispatch(JSON.parse(line)); }
    catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  }
});
process.stdin.on("end", () => { stdinClosed = true; if (pending === 0) process.exit(0); });
