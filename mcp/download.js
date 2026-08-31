"use strict";

const dns = require("dns");
const fs = require("fs");
const https = require("https");
const net = require("net");
const path = require("path");

function ipv4Private(address) {
  const parts = address.split(".").map(Number);
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] >= 224;
}

function addressAllowed(address) {
  const kind = net.isIP(address);
  if (kind === 4) return !ipv4Private(address);
  if (kind !== 6) return false;
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" || value === "::1" || value.startsWith("fe8") || value.startsWith("fe9") ||
      value.startsWith("fea") || value.startsWith("feb") || value.startsWith("fc") || value.startsWith("fd")) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  return !mapped || !ipv4Private(mapped[1]);
}

async function resolvePublic(hostname) {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  const selected = records.find((record) => addressAllowed(record.address));
  if (!selected || records.some((record) => !addressAllowed(record.address)))
    throw new Error("download host resolves to a private or reserved address");
  return selected;
}

async function downloadHttps(source, destination, redirects = 0) {
  if (redirects > 3) throw new Error("too many download redirects");
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("downloadUrl must be an HTTPS URL without embedded credentials");
  const resolved = await resolvePublic(url.hostname);
  const maxBytes = Number(process.env.FABLECUT_MAX_ANALYSIS_BYTES || 1024 * 1024 * 1024);
  const timeoutMs = Number(process.env.FABLECUT_ANALYSIS_DOWNLOAD_TIMEOUT_MS || 120_000);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { fs.rmSync(destination, { force: true }); } catch {}
      reject(error);
    };
    const req = https.request(url, {
      method: "GET",
      headers: { "User-Agent": "FableCut-MCP/2.0", Accept: "*/*" },
      lookup: (_host, _opts, callback) => callback(null, resolved.address, resolved.family),
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const location = res.headers.location;
        if (!location) return fail(new Error("download redirect has no Location"));
        settled = true;
        downloadHttps(new URL(location, url).toString(), destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return fail(new Error(`download failed with HTTP ${res.statusCode}`));
      }
      const declared = Number(res.headers["content-length"] || 0);
      if (declared > maxBytes) { res.resume(); return fail(new Error(`download exceeds ${maxBytes} bytes`)); }
      const out = fs.createWriteStream(destination, { mode: 0o600 });
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          res.destroy(new Error(`download exceeds ${maxBytes} bytes`));
          out.destroy();
        }
      });
      res.on("error", fail);
      out.on("error", fail);
      out.on("finish", () => {
        if (settled) return;
        settled = true;
        out.close(() => resolve({ bytes: received, file: destination }));
      });
      res.pipe(out);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("download timed out")));
    req.on("error", fail);
    req.end();
  });
}

function extensionFor(name) {
  const ext = path.extname(name || "").toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".bin";
}

module.exports = { addressAllowed, downloadHttps, extensionFor };
