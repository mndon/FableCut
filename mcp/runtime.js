"use strict";

const path = require("path");

const { FableCutCore } = require("./core");
const { McpProtocol } = require("./protocol");
const { ProjectStore } = require("./storage");

function dataRoot(appDir) {
  return path.resolve(process.env.FABLECUT_MCP_DATA_DIR || path.join(appDir, "mcp-data"));
}

function createRuntime(appDir, options = {}) {
  const store = new ProjectStore(dataRoot(appDir), { mediaReference: options.mediaReference });
  const core = new FableCutCore({ store, appDir, mediaReference: options.mediaReference });
  return { core, protocol: new McpProtocol(core, options.protocol), store };
}

module.exports = { createRuntime, dataRoot };
