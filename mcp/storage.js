"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { assertProjectId, codedError, newProject, validateProject } = require("./project");

function ownerKey(issuer, subject) {
  return crypto.createHash("sha256").update(`${issuer}\0${subject}`).digest("hex");
}

class ProjectStore {
  constructor(root, { mediaReference = "assetId" } = {}) {
    this.root = path.resolve(root);
    this.mediaReference = mediaReference;
    this.projectsDir = path.join(this.root, "projects");
    this.queues = new Map();
    fs.mkdirSync(this.projectsDir, { recursive: true });
  }

  paths(projectId) {
    const id = assertProjectId(projectId);
    const dir = path.join(this.projectsDir, id);
    return {
      id,
      dir,
      project: path.join(dir, "project.json"),
      meta: path.join(dir, "metadata.json"),
      analysis: path.join(dir, "analysis"),
    };
  }

  atomicJSON(file, value) {
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  create(identity, options) {
    const max = Number(process.env.FABLECUT_MAX_PROJECTS_PER_USER || 100);
    let owned = 0;
    for (const entry of fs.readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.projectsDir, entry.name, "metadata.json"), "utf8"));
        if (meta.ownerKey === identity.ownerKey) owned++;
      } catch {}
    }
    if (owned >= max) throw codedError("PROJECT_LIMIT", `project limit reached (${max})`);

    for (;;) {
      const id = crypto.randomUUID();
      const p = this.paths(id);
      try { fs.mkdirSync(p.dir, { mode: 0o700 }); } catch (error) {
        if (error.code === "EEXIST") continue;
        throw error;
      }
      fs.mkdirSync(p.analysis, { mode: 0o700 });
      const now = new Date().toISOString();
      const project = newProject(options);
      this.atomicJSON(p.meta, { ownerKey: identity.ownerKey, createdAt: now, updatedAt: now });
      this.atomicJSON(p.project, project);
      return { projectId: id, project };
    }
  }

  authorize(projectId, identity) {
    const p = this.paths(projectId);
    try {
      const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
      if (typeof meta.ownerKey !== "string" ||
          !crypto.timingSafeEqual(Buffer.from(meta.ownerKey), Buffer.from(identity.ownerKey))) throw new Error("owner mismatch");
    } catch {
      throw codedError("PROJECT_NOT_FOUND", "project not found");
    }
    return p;
  }

  read(projectId, identity) {
    const p = this.authorize(projectId, identity);
    try {
      const doc = JSON.parse(fs.readFileSync(p.project, "utf8").replace(/^\uFEFF/, ""));
      return validateProject(doc, { mediaReference: this.mediaReference });
    } catch (error) {
      if (error.public) throw error;
      throw codedError("PROJECT_CORRUPT", "stored project.json is invalid");
    }
  }

  async write(projectId, identity, callback) {
    const id = assertProjectId(projectId);
    const prior = this.queues.get(id) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const tail = prior.then(() => turn);
    this.queues.set(id, tail);
    await prior;
    try {
      const p = this.authorize(id, identity);
      const current = this.read(id, identity);
      const output = await callback(current, p);
      if (output && output.project) {
        validateProject(output.project, { mediaReference: this.mediaReference });
        const bytes = Buffer.byteLength(JSON.stringify(output.project));
        const max = Number(process.env.FABLECUT_MAX_PROJECT_BYTES || 5 * 1024 * 1024);
        if (bytes > max) throw codedError("PROJECT_TOO_LARGE", `project exceeds ${max} bytes`);
        this.atomicJSON(p.project, output.project);
        try {
          const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
          meta.updatedAt = new Date().toISOString();
          this.atomicJSON(p.meta, meta);
        } catch {}
      }
      return output;
    } finally {
      release();
      if (this.queues.get(id) === tail) this.queues.delete(id);
    }
  }

  analysisFile(projectId, identity, key) {
    const p = this.authorize(projectId, identity);
    fs.mkdirSync(p.analysis, { recursive: true, mode: 0o700 });
    return path.join(p.analysis, `${crypto.createHash("sha256").update(key).digest("hex")}.json`);
  }
}

module.exports = { ProjectStore, ownerKey };
