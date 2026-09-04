"use strict";

const fs = require("fs");
const path = require("path");

const cliDir = path.resolve(__dirname, "..");
const root = path.resolve(cliDir, "..");
const target = path.join(cliDir, "runtime");
const entries = [
  "server.js", "paths.js", "analyze.js", "app.js", "index.html", "style.css",
  "meter-worklet.js", "ruler-worker.js", "manifest.json", "favicon.svg", "icons", "library",
];

const missing = entries.filter((entry) => !fs.existsSync(path.join(root, entry)));
if (missing.length) {
  /* Registry installs already contain runtime/. `npm rebuild` may execute the
     prepare hook again, but the repository sources are intentionally absent. */
  if (fs.existsSync(path.join(target, "server.js"))) process.exit(0);
  throw new Error("Missing FableCut source entries: " + missing.join(", "));
}
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const entry of entries) {
  const source = path.join(root, entry);
  fs.cpSync(source, path.join(target, entry), { recursive: true });
}
