#!/usr/bin/env node
"use strict";

require("../lib/cli").main().catch((error) => {
  const token = process.env.FABLECUT_TOKEN || "";
  let message = error && error.message ? error.message : String(error);
  if (token) message = message.split(token).join("[redacted]");
  console.error("Error: " + message);
  process.exitCode = error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
});
