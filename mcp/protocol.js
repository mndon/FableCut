"use strict";

const SUPPORTED_PROTOCOLS = new Set(["2025-11-25", "2025-06-18"]);
const LATEST_PROTOCOL = "2025-11-25";
const { validateSchema } = require("./schema");

function textFor(value) {
  if (value && typeof value.markdown === "string") return value.markdown;
  if (value && typeof value.summary === "string") return value.summary;
  return JSON.stringify(value, null, 2);
}

function toolSuccess(value) {
  return { content: [{ type: "text", text: textFor(value) }], structuredContent: value, isError: false };
}

function toolFailure(error) {
  const code = error.public ? error.code : "INTERNAL_ERROR";
  const message = error.public ? error.message : "internal server error";
  const structuredContent = { error: { code, message } };
  if (error.public && error.details) Object.assign(structuredContent.error, error.details);
  return { content: [{ type: "text", text: `Error [${code}]: ${structuredContent.error.message}` }], structuredContent, isError: true };
}

function protocolError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

class McpProtocol {
  constructor(core, { disabledTools = [] } = {}) {
    this.core = core;
    const disabled = new Set(disabledTools);
    this.availableTools = core.tools().filter((tool) => !disabled.has(tool.name));
  }

  async handle(message, identity) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string")
      return protocolError(message?.id, -32600, "Invalid Request");
    const { id, method, params = {} } = message;
    const notification = id === undefined || id === null;
    if (method === "initialize") {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : LATEST_PROTOCOL;
      return { jsonrpc: "2.0", id, result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fablecut", version: "2.0.0" },
      } };
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    if (method === "ping") return notification ? null : { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return notification ? null : { jsonrpc: "2.0", id, result: { tools: this.availableTools } };
    if (method === "tools/call") {
      if (notification) return null;
      if (!params || typeof params.name !== "string")
        return protocolError(id, -32602, "tools/call requires params.name");
      const argumentsValue = params.arguments ?? {};
      if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue))
        return protocolError(id, -32602, "tools/call arguments must be an object");
      const tool = this.availableTools.find((candidate) => candidate.name === params.name);
      if (!tool)
        return protocolError(id, -32602, `Unknown tool: ${params.name}`);
      try { validateSchema(argumentsValue, tool.inputSchema); }
      catch (error) { return protocolError(id, -32602, error.message); }
      try {
        const value = await this.core.call(params.name, argumentsValue, identity);
        return { jsonrpc: "2.0", id, result: toolSuccess(value) };
      } catch (error) {
        return { jsonrpc: "2.0", id, result: toolFailure(error) };
      }
    }
    return notification ? null : protocolError(id, -32601, `Method not found: ${method}`);
  }
}

module.exports = { LATEST_PROTOCOL, McpProtocol, SUPPORTED_PROTOCOLS, protocolError };
