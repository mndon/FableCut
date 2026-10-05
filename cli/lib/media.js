"use strict";
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { runAsr, validateResult } = require("./asr");
const { downloadFile, outputPath, httpURL } = require("./download");

function validateAsrLocalPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || !(path.posix.isAbsolute(value) || path.win32.isAbsolute(value)))
    throw new Error("asrLocalPath must be an absolute local path");
  return value;
}
function readResult(file) {
  validateAsrLocalPath(file);
  if (!path.isAbsolute(file)) throw new Error("ASR local path belongs to another platform");
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("ASR local result is missing, unreadable or invalid JSON: " + file); }
  return validateResult(value);
}
function localSource(media, pp, paths) {
  const prefix = `/projects/${pp.id}/media/`;
  const root = media.src?.startsWith(prefix) ? pp.mediaDir : media.src?.startsWith("/library/") ? paths.LIBRARY_DIR : null;
  if (!root) throw new Error("ASR requires imported local media; import remote media first");
  const relative = decodeURIComponent(media.src.slice(root === pp.mediaDir ? prefix.length : "/library/".length));
  const file = fs.realpathSync(path.resolve(root, relative));
  const within = path.relative(fs.realpathSync(root), file);
  if (!within || within === ".." || within.startsWith(".." + path.sep) || path.isAbsolute(within)) throw new Error("ASR media path escapes its media directory");
  return file;
}
async function runMediaAsr(local, id, mediaId, options, { signal, transcribe = runAsr, download = downloadFile } = {}) {
  const { store, paths } = local, pp = store.context(id);
  let expected = store.read(id).media.find(m => m.id === mediaId);
  if (!expected) throw new Error("Unknown media: " + mediaId);
  if (!["video", "audio"].includes(expected.kind)) throw new Error("ASR requires audio or video media");
  expected = { ...expected };
  if (expected.asrLocalPath !== undefined) validateAsrLocalPath(expected.asrLocalPath);
  if (expected.asrUrl !== undefined) httpURL(expected.asrUrl);
  let savedPath, url = expected.asrUrl;
  const checkCancelled = () => { if (signal?.aborted) throw new Error("ASR cancelled"); };
  const commit = changes => {
    checkCancelled();
    const project = store.update(id, current => {
      const media = current.media.find(m => m.id === mediaId);
      if (!media || ["src", "kind", "asrUrl", "asrLocalPath"].some(key => media[key] !== expected[key]))
        throw new Error("CONFLICT — media source or ASR binding changed; result not bound");
      if (Object.entries(changes).some(([key, value]) => media[key] !== value)) {
        Object.assign(media, changes);
        current.revision = Number(current.revision || 0) + 1;
      }
      expected = { ...media };
      return current;
    });
    return { ok: true, project: id, revision: project.revision, media: expected, path: savedPath, ...(url ? { json_url: url } : {}) };
  };
  try {
    checkCancelled();
    let reusable = false;
    if (expected.asrLocalPath) {
      try { readResult(expected.asrLocalPath); reusable = true; } catch (error) { if (!url) throw error; }
    }
    if (reusable && (options.output === undefined || path.resolve(options.output) === expected.asrLocalPath)) {
      savedPath = expected.asrLocalPath;
      return commit({});
    }
    const target = outputPath(options.output === undefined
      ? path.join(pp.analysisDir, "asr", `${String(mediaId).replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}.json`)
      : options.output);
    if (reusable) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(expected.asrLocalPath, target, fs.constants.COPYFILE_EXCL);
      savedPath = target;
      readResult(savedPath);
    } else {
      if (!url) {
        const source = localSource(expected, pp, paths);
        const result = await transcribe({ path: source, "api-url": options["api-url"] }, { signal });
        url = result.json_url;
        commit({ asrUrl: url });
      }
      checkCancelled();
      savedPath = (await download(url, target, { signal, validate: readResult })).path;
    }
    return commit({ asrLocalPath: savedPath });
  } catch (error) {
    throw new Error(`${error.message}${url ? `; json_url=${url}` : ""}${savedPath ? `; path=${savedPath}` : ""}`);
  }
}
module.exports = { runMediaAsr, validateAsrLocalPath, readResult, localSource };
