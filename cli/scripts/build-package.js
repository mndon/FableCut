"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const cliDir = path.resolve(__dirname, "..");
const dist = path.join(cliDir, "dist");

async function build() {
  // Registry installs contain only dist/. Rebuilds need no development tools.
  if (!fs.existsSync(path.join(cliDir, "lib/cli.js"))) {
    for (const file of ["bin/tik-video-editor-cli.js", "runtime/server.js"]) {
      if (!fs.existsSync(path.join(dist, file))) throw new Error("Incomplete CLI distribution: " + file);
    }
    return;
  }
  const { minify } = require("terser");
  const obfuscator = require("javascript-obfuscator");
  execFileSync(process.execPath, [path.join(__dirname, "pack-runtime.js")], { stdio: "inherit" });
  const staging = fs.mkdtempSync(path.join(cliDir, ".dist-"));
  let before = 0, after = 0;
  try {
    for (const dir of ["bin", "lib", "runtime"]) fs.cpSync(path.join(cliDir, dir), path.join(staging, dir), { recursive: true });
    // These scripts share browser globals with inline HTML and other scripts.
    const browserScripts = new Set(["app.js", "i18n.js", "optimized-export.js", "meter-worklet.js", "ruler-worker.js"]);
    async function transform(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { await transform(file); continue; }
        if (!entry.name.endsWith(".js")) continue;
        const relative = path.relative(staging, file);
        const isCLI = relative.startsWith("bin" + path.sep) || relative.startsWith("lib" + path.sep);
        const browser = relative.startsWith("runtime" + path.sep) && browserScripts.has(entry.name);
        const source = fs.readFileSync(file, "utf8");
        const result = await minify(source, {
          ecma: 2022,
          compress: { passes: 2, toplevel: !browser },
          mangle: { toplevel: !browser },
          format: { comments: /^!|@license|@preserve/i, shebang: true },
          sourceMap: false,
        });
        let code = result.code;
        if (isCLI) {
          const shebang = code.startsWith("#!") ? code.slice(0, code.indexOf("\n") + 1) : "";
          code = shebang + obfuscator.obfuscate(code.slice(shebang.length), {
            target: "node", seed: 1701, compact: true,
            identifierNamesGenerator: "hexadecimal", renameGlobals: false,
            stringArray: true, stringArrayEncoding: ["base64"], stringArrayThreshold: 0.75,
            controlFlowFlattening: false, deadCodeInjection: false,
            debugProtection: false, selfDefending: false,
            sourceMap: false,
          }).getObfuscatedCode();
        }
        fs.writeFileSync(file, code + "\n");
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
        before += Buffer.byteLength(source); after += Buffer.byteLength(code + "\n");
      }
    }
    await transform(staging);
    fs.chmodSync(path.join(staging, "bin/tik-video-editor-cli.js"), 0o755);
    // Preserve upstream MIT separately; never overwrite the CLI's own license.
    fs.copyFileSync(path.join(cliDir, "../LICENSE"), path.join(staging, "runtime/LICENSE"));
    fs.rmSync(dist, { recursive: true, force: true });
    fs.renameSync(staging, dist);
    console.error(`CLI distribution: JavaScript ${before} → ${after} bytes; no source maps`);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

build().catch(error => { console.error(error.message); process.exitCode = 1; });
