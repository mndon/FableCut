"use strict";
const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { withDeadline } = require("./operation");

function httpURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("URL must be an absolute HTTP(S) URL without credentials"); }
  if (typeof value !== "string" || /[\s\\]/.test(value) || !/^https?:\/\//i.test(value) || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("URL must be an absolute HTTP(S) URL without credentials");
  return url;
}
function outputPath(value) {
  const target = path.resolve(value);
  try { fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return target; throw error; }
  throw new Error("Output already exists: " + target);
}
async function downloadFile(url, output, { validate, timeout = 60000, signal: externalSignal } = {}) {
  let current = httpURL(url);
  const target = outputPath(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + ".part-" + randomBytes(8).toString("hex");
  return withDeadline(timeout, externalSignal, async signal => {
    try {
      let response;
      for (let redirects = 0; ; redirects++) {
        response = await fetch(current, { redirect: "manual", signal });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        if (redirects >= 5 || !response.headers.get("location")) throw new Error("Download redirect limit exceeded or missing location");
        current = httpURL(new URL(response.headers.get("location"), current).href);
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error("Download failed: HTTP " + response.status); }
      if (!response.body) throw new Error("Download returned no body");
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: "wx" }), { signal });
      if (validate) await validate(temporary);
      // Exclusive publication prevents overwriting a target created during download.
      fs.linkSync(temporary, target);
      return { path: target };
    } catch (error) {
      if (externalSignal?.aborted) throw new Error("Download cancelled");
      if (/^(Download|Output|ASR|URL)/.test(error.message)) throw error;
      throw new Error("Download or save failed; check the network, URL and output directory");
    } finally { fs.rmSync(temporary, { force: true }); }
  });
}
module.exports = { downloadFile, httpURL, outputPath };
