/* Shared local persistence. All project writers use the same process lock. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const paths = require("./paths");

function withLock(file, action) {
  const deadline = Date.now() + 10000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(file, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock: ${file}. If its owner has exited, remove this lock and retry.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.closeSync(fd); } finally { fs.unlinkSync(file); }
  };
  try {
    fs.writeFileSync(fd, String(process.pid));
    const result = action();
    if (result && typeof result.then === "function") return result.finally(release);
    release();
    return result;
  } catch (error) { release(); throw error; }
}

function context(id) {
  const pp = paths.projectPaths(id);
  if (!fs.existsSync(pp.projectFile)) throw new Error("No such project: " + pp.id);
  return pp;
}
function read(id) {
  return JSON.parse(fs.readFileSync(context(id).projectFile, "utf8").replace(/^\uFEFF/, ""));
}
function atomicWrite(file, doc) {
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { flag: "wx" });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
function conflict(revision) {
  const error = new Error("CONFLICT — stale revision; project changed since it was read");
  error.status = 409; error.revision = revision;
  return error;
}
function update(id, transform) {
  const pp = context(id);
  return withLock(path.join(pp.dir, ".write.lock"), () => {
    const current = read(id);
    const doc = transform(current);
    atomicWrite(pp.projectFile, doc);
    return doc;
  });
}
function save(id, doc, force = false) {
  return update(id, current => {
    if (!force && (doc.revision || 0) <= (current.revision || 0)) throw conflict(current.revision || 0);
    return { ...doc, revision: Math.max(Number(doc.revision || 0), Number(current.revision || 0) + 1) };
  });
}
function create(name, requestedId) {
  name = String(name || "Untitled Project").trim() || "Untitled Project";
  const stem = String(requestedId || name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "project";
  return withLock(path.join(paths.DATA_DIR, ".projects.lock"), () => {
    let id = paths.normalizeProjectId(stem), n = 2;
    for (;;) {
      try { fs.mkdirSync(paths.projectPaths(id).dir); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; id = paths.normalizeProjectId(`${stem}-${n++}`); }
    }
    paths.ensureProject(id, name);
    return { id, name };
  });
}
module.exports = { withLock, context, read, update, save, create, atomicWrite };
