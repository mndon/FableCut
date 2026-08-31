"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { analyze } = require("../analyze");
const { downloadHttps, extensionFor } = require("./download");
const { codedError, newEntityId, validateProject } = require("./project");

const READ_SCOPE = "fablecut:projects:read";
const WRITE_SCOPE = "fablecut:projects:write";
const WRITE_TOOLS = new Set(["fablecut_create_project", "fablecut_patch_project", "fablecut_set_project", "fablecut_import_media", "fablecut_analyze_reference"]);
const PROJECT_ID = { type: "string", format: "uuid", description: "FableCut project UUID" };
const OBJECT_OUTPUT = { type: "object", additionalProperties: true };

function schema(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}

const BASE_TOOLS = [
  {
    name: "fablecut_create_project",
    description: "Create a FableCut project and return its generated projectId plus initial project.json.",
    inputSchema: schema({
      name: { type: "string" }, width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 }, fps: { type: "number", exclusiveMinimum: 0 },
    }, []),
    outputSchema: OBJECT_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "fablecut_status",
    description: "Return the MCP service status and selected-project summary. This does not start the legacy Web UI.",
    inputSchema: schema({ projectId: PROJECT_ID }, ["projectId"]), outputSchema: OBJECT_OUTPUT,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "fablecut_docs",
    description: "Return FableCut schema and editing documentation without requiring a project, optionally filtered to matching ## sections.",
    inputSchema: schema({ section: { type: "string" } }, []), outputSchema: OBJECT_OUTPUT,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "fablecut_get_project",
    description: "Get project.json as structured content. compact:true returns a token-efficient timeline summary.",
    inputSchema: schema({ projectId: PROJECT_ID, compact: { type: "boolean" } }, ["projectId"]), outputSchema: OBJECT_OUTPUT,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "fablecut_patch_project",
    description: "Atomically apply targeted add/update/remove clip or media operations and project-field updates to the latest revision.",
    inputSchema: schema({ projectId: PROJECT_ID, ops: { type: "array", minItems: 1, items: { type: "object" } } }, ["projectId", "ops"]),
    outputSchema: OBJECT_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "fablecut_set_project",
    description: "Replace project.json. The submitted revision must equal the stored revision; the server increments it on save.",
    inputSchema: schema({
      projectId: PROJECT_ID,
      project: { type: "object" },
      force: { type: "boolean", description: "Deliberately overwrite a newer revision" },
    }, ["projectId", "project"]),
    outputSchema: OBJECT_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "fablecut_import_media",
    description: "Register upstream media in project.json.",
    inputSchema: schema({
      projectId: PROJECT_ID,
      asset: schema({
        assetId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 },
        kind: { type: "string", enum: ["video", "audio", "image", "svg"] },
        duration: { type: "number", minimum: 0 }, width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 }, folderId: { type: ["string", "null"] },
      }, ["assetId", "name", "kind"]),
    }, ["projectId", "asset"]),
    outputSchema: OBJECT_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "fablecut_analyze_reference",
    description: "Temporarily download an already-registered video asset and return its cuts, beats, BPM, energy, drop and original-asset music reference.",
    inputSchema: schema({
      projectId: PROJECT_ID, assetId: { type: "string", minLength: 1 },
      downloadUrl: { type: "string", format: "uri" }, threshold: { type: "number", minimum: 0, maximum: 1 },
    }, ["projectId", "assetId", "downloadUrl"]),
    outputSchema: OBJECT_OUTPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

function toolsFor(mediaReference) {
  const tools = jsonClone(BASE_TOOLS);
  const tool = tools.find((item) => item.name === "fablecut_import_media");
  const asset = tool.inputSchema.properties.asset;
  if (mediaReference === "src") {
    delete asset.properties.assetId;
    asset.properties.src = { type: "string", minLength: 1,
      description: "Client-playable media URL or path persisted in project.json" };
    asset.required = ["src", "name", "kind"];
    tool.description = "Register client-playable media in project.json. The service stores src and metadata, never media bytes.";
  }
  return tools;
}

const DEFAULTS = {
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1, speed: 1,
  blend: "normal", fit: "contain", cropL: 0, cropR: 0, cropT: 0, cropB: 0,
  cornerRadius: 0, flipH: false, flipV: false, filterPreset: "none",
  brightness: 100, contrast: 100, saturation: 100, hue: 0, temperature: 0,
  tint: 0, blur: 0, grayscale: 0, sepia: 0, invert: 0, vignette: 0,
  shake: 0, shakeSpeed: 8, rgbSplit: 0, grain: 0,
  chromaKey: "", chromaTolerance: 26, chromaSoftness: 12, bgRemove: false,
  text: "Title", fontSize: 72, color: "#ffffff", color2: "", font: "Segoe UI",
  bold: true, weight: 0, italic: false, uppercase: false, align: "center",
  letterSpacing: 0, lineHeight: 1.2, textShadow: 12, glow: 0, glowColor: "",
  strokeWidth: 0, strokeColor: "#000", bgColor: "#000", bgOpacity: 0,
  textAnim: "none", wordRate: 0.15,
};

function jsonClone(value) { return JSON.parse(JSON.stringify(value)); }
function duration(doc) { return doc.clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0); }

function compactProject(doc, mediaReference = "assetId") {
  const props = (values, kind) => {
    const kept = {};
    for (const [key, value] of Object.entries(values || {})) {
      if (kind !== "text" && key === "text" && value === "Title") continue;
      if (!(key in DEFAULTS) || JSON.stringify(DEFAULTS[key]) !== JSON.stringify(value)) kept[key] = value;
    }
    return Object.keys(kept).length ? ` ${JSON.stringify(kept)}` : "";
  };
  const lines = [
    `"${doc.name}" ${doc.width}x${doc.height}@${doc.fps} schema:${doc.schemaVersion} rev:${doc.revision}`,
    `MEDIA (${doc.media.length}):`,
    ...doc.media.map((m) => `  ${m.id} ${m.kind} ${mediaReference}:${m[mediaReference]} "${m.name}"${m.duration != null ? ` ${m.duration}s` : ""}`),
    `CLIPS (${doc.clips.length}), by track/time:`,
    ...doc.clips.slice().sort((a, b) => a.track === b.track ? a.start - b.start : a.track.localeCompare(b.track)).map((c) =>
      `  ${c.id} ${c.track} ${c.start}s+${c.duration}s ${c.kind}` +
      (c.mediaId ? `(${c.mediaId}${c.in ? ` in:${c.in}` : ""})` : "") +
      (c.name ? ` "${c.name}"` : "") + props(c.props, c.kind) +
      (c.keyframes ? ` kf:${Object.entries(c.keyframes).map(([k, v]) => `${k}(${v.length})`).join(",")}` : "") +
      (c.transitionIn ? ` in:${c.transitionIn.type}/${c.transitionIn.duration}` : "") +
      (c.transitionOut ? ` out:${c.transitionOut.type}/${c.transitionOut.duration}` : "")),
  ];
  return lines.join("\n");
}

function mergeInto(target, changes) {
  for (const [key, value] of Object.entries(changes || {})) {
    if (value === null) delete target[key];
    else if (key === "props" && target.props && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [prop, propValue] of Object.entries(value)) {
        if (propValue === null) delete target.props[prop]; else target.props[prop] = propValue;
      }
    } else target[key] = jsonClone(value);
  }
}

function applyOps(project, ops, mediaReference = "assetId") {
  if (!Array.isArray(ops) || !ops.length) throw codedError("INVALID_PATCH", "ops must be a non-empty array");
  const notes = [];
  for (const raw of ops) {
    const op = jsonClone(raw);
    switch (op.op) {
      case "addClip": {
        const clip = op.clip;
        if (!clip || !clip.track || typeof clip.start !== "number" || typeof clip.duration !== "number")
          throw codedError("INVALID_PATCH", "addClip needs clip{track,start,duration}");
        clip.id ||= newEntityId("c");
        if (project.clips.some((item) => item.id === clip.id)) throw codedError("INVALID_PATCH", `duplicate clip id ${clip.id}`);
        project.clips.push(clip); notes.push(`+${clip.id}`); break;
      }
      case "updateClip": {
        const clip = project.clips.find((item) => item.id === op.id);
        if (!clip) throw codedError("INVALID_PATCH", `no clip ${op.id}`);
        mergeInto(clip, op.set); notes.push(`~${op.id}`); break;
      }
      case "removeClip": {
        const index = project.clips.findIndex((item) => item.id === op.id);
        if (index < 0) throw codedError("INVALID_PATCH", `no clip ${op.id}`);
        project.clips.splice(index, 1); notes.push(`-${op.id}`); break;
      }
      case "addMedia": {
        const media = op.media;
        if (!media || !media[mediaReference] || !media.kind)
          throw codedError("INVALID_PATCH", `addMedia needs media{${mediaReference},kind}`);
        media.id ||= newEntityId("m");
        media.name ||= media[mediaReference];
        if (project.media.some((item) => item.id === media.id || item[mediaReference] === media[mediaReference]))
          throw codedError("INVALID_PATCH", `duplicate media id or ${mediaReference} ${media.id}`);
        project.media.push(media); notes.push(`+${media.id}`); break;
      }
      case "removeMedia": {
        const used = project.clips.find((clip) => clip.mediaId === op.id);
        if (used) throw codedError("INVALID_PATCH", `media ${op.id} is used by clip ${used.id}`);
        const index = project.media.findIndex((item) => item.id === op.id);
        if (index < 0) throw codedError("INVALID_PATCH", `no media ${op.id}`);
        project.media.splice(index, 1); notes.push(`-${op.id}`); break;
      }
      case "setProject": {
        const allowed = new Set(["name", "width", "height", "fps", "background", "markers", "folders", "inPoint", "outPoint", "disabledTracks"]);
        for (const [key, value] of Object.entries(op.set || {})) {
          if (!allowed.has(key)) throw codedError("INVALID_PATCH", `setProject cannot set ${key}`);
          if (value === null) delete project[key]; else project[key] = jsonClone(value);
        }
        notes.push("~project"); break;
      }
      default: throw codedError("INVALID_PATCH", `unknown op ${op.op}`);
    }
  }
  validateProject(project, { mediaReference });
  return notes;
}

class FableCutCore {
  constructor({ store, appDir, analyzeFn = analyze, downloadFn = downloadHttps, mediaReference = "assetId" }) {
    this.store = store;
    this.appDir = appDir;
    this.analyzeFn = analyzeFn;
    this.downloadFn = downloadFn;
    this.mediaReference = mediaReference;
    this.activeAnalyses = new Map();
    this.globalAnalyses = 0;
  }

  tools() { return toolsFor(this.mediaReference); }

  requireScope(identity, scope) {
    if (!identity || !identity.ownerKey) throw codedError("UNAUTHENTICATED", "authentication required");
    if (!identity.local && !identity.scopes.has(scope)) throw codedError("INSUFFICIENT_SCOPE", `required scope: ${scope}`);
  }

  async call(name, args, identity) {
    this.requireScope(identity, WRITE_TOOLS.has(name) ? WRITE_SCOPE : READ_SCOPE);
    if (name !== "fablecut_create_project" && name !== "fablecut_docs") this.store.authorize(args.projectId, identity);

    switch (name) {
      case "fablecut_create_project": return this.store.create(identity, args);
      case "fablecut_status": {
        const project = this.store.read(args.projectId, identity);
        return { service: "fablecut-mcp", version: "2.0.0", projectId: args.projectId, schemaVersion: 1,
          project: { name: project.name, width: project.width, height: project.height, fps: project.fps,
            revision: project.revision, clips: project.clips.length, media: project.media.length, duration: duration(project) } };
      }
      case "fablecut_docs": {
        const markdown = fs.readFileSync(path.join(this.appDir, "CLAUDE.md"), "utf8");
        if (!args.section) return { markdown };
        const query = args.section.toLowerCase();
        const parts = markdown.split(/^(?=## )/m);
        const hits = parts.filter((part) => part.startsWith("## ") && part.slice(0, part.indexOf("\n")).toLowerCase().includes(query));
        return { markdown: hits.join("\n"), matched: hits.length };
      }
      case "fablecut_get_project": {
        const project = this.store.read(args.projectId, identity);
        return args.compact ? { projectId: args.projectId, revision: project.revision,
          summary: compactProject(project, this.mediaReference) }
          : { projectId: args.projectId, revision: project.revision, project };
      }
      case "fablecut_set_project": return this.store.write(args.projectId, identity, (current) => {
        const project = jsonClone(args.project);
        validateProject(project, { mediaReference: this.mediaReference });
        if (!args.force && project.revision !== current.revision)
          throw codedError("CONFLICT", `project is at revision ${current.revision}; submitted revision is ${project.revision}`,
            { currentRevision: current.revision, submittedRevision: project.revision });
        project.revision = current.revision + 1;
        return { project, value: { projectId: args.projectId, revision: project.revision, project } };
      }).then((result) => result.value);
      case "fablecut_patch_project": return this.store.write(args.projectId, identity, (current) => {
        const project = jsonClone(current);
        const notes = applyOps(project, args.ops, this.mediaReference);
        project.revision = current.revision + 1;
        return { project, value: { projectId: args.projectId, revision: project.revision, notes,
          clips: project.clips.length, media: project.media.length } };
      }).then((result) => result.value);
      case "fablecut_import_media": return this.store.write(args.projectId, identity, (current) => {
        const project = jsonClone(current);
        const existing = project.media.find((media) => media[this.mediaReference] === args.asset[this.mediaReference]);
        if (existing) return { value: { projectId: args.projectId, revision: project.revision, media: existing, created: false } };
        const media = { id: newEntityId("m"), ...jsonClone(args.asset) };
        project.media.push(media);
        validateProject(project, { mediaReference: this.mediaReference });
        project.revision = current.revision + 1;
        return { project, value: { projectId: args.projectId, revision: project.revision, media, created: true } };
      }).then((result) => result.value);
      case "fablecut_analyze_reference": return this.analyzeReference(args, identity);
      default: throw codedError("UNKNOWN_TOOL", `unknown tool: ${name}`);
    }
  }

  async analyzeReference(args, identity) {
    const project = this.store.read(args.projectId, identity);
    const media = project.media.find((item) => item.assetId === args.assetId);
    if (!media) throw codedError("ASSET_NOT_FOUND", `assetId ${args.assetId} is not registered in this project`);
    if (media.kind !== "video") throw codedError("INVALID_ASSET", "reference asset must have kind video");
    const cache = this.store.analysisFile(args.projectId, identity, `${args.assetId}\0${args.threshold ?? "adaptive"}`);
    try {
      const blueprint = JSON.parse(fs.readFileSync(cache, "utf8"));
      return { projectId: args.projectId, assetId: args.assetId, cached: true, blueprint };
    } catch {}

    const perUser = this.activeAnalyses.get(identity.ownerKey) || 0;
    const perUserMax = Number(process.env.FABLECUT_ANALYSIS_PER_USER || 1);
    const globalMax = Number(process.env.FABLECUT_ANALYSIS_CONCURRENCY || 2);
    if (perUser >= perUserMax || this.globalAnalyses >= globalMax)
      throw codedError("ANALYSIS_BUSY", "analysis concurrency limit reached; retry later");
    this.activeAnalyses.set(identity.ownerKey, perUser + 1);
    this.globalAnalyses++;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-analysis-"));
    const file = path.join(dir, `reference${extensionFor(media.name)}`);
    try {
      try { await this.downloadFn(args.downloadUrl, file); }
      catch (error) { throw codedError("ASSET_DOWNLOAD_FAILED", error.message || "asset download failed"); }
      let blueprint;
      try { blueprint = await this.analyzeFn(file, { threshold: args.threshold, music: false, srcUrl: `asset:${args.assetId}` }); }
      catch { throw codedError("ANALYSIS_FAILED", "reference analysis failed; check ffmpeg and the source asset"); }
      blueprint.music = blueprint.hasAudio ? { assetId: args.assetId, mediaId: media.id } : null;
      const tmp = `${cache}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(blueprint, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, cache);
      return { projectId: args.projectId, assetId: args.assetId, cached: false, blueprint };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      const left = (this.activeAnalyses.get(identity.ownerKey) || 1) - 1;
      if (left) this.activeAnalyses.set(identity.ownerKey, left); else this.activeAnalyses.delete(identity.ownerKey);
      this.globalAnalyses--;
    }
  }
}

const TOOLS = toolsFor("assetId");
module.exports = { FableCutCore, READ_SCOPE, TOOLS, WRITE_SCOPE, WRITE_TOOLS, compactProject };
