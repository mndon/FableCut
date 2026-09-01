/* FableCut storage layout. App assets are read-only; user projects live under
   DATA_DIR/projects/<id> and share the reusable DATA_DIR/library. */
"use strict";
const fs = require("fs");
const path = require("path");

const APP_DIR = __dirname;
const DATA_DIR = process.env.FABLECUT_DATA_DIR
  ? path.resolve(process.env.FABLECUT_DATA_DIR)
  : APP_DIR;
const SPLIT = DATA_DIR !== APP_DIR;
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const LIBRARY_DIR = path.join(DATA_DIR, "library");
const LIBRARY_SUBDIRS = ["sfx", "elements", "svg", "fonts"];
const DEFAULT_PROJECT_ID = "default";

function normalizeProjectId(value) {
  const id = String(value || DEFAULT_PROJECT_ID).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))
    throw new Error("project id must be 1-64 lowercase letters, numbers, _ or -");
  return id;
}

function projectPaths(id = DEFAULT_PROJECT_ID) {
  id = normalizeProjectId(id);
  const dir = path.join(PROJECTS_DIR, id);
  return {
    id, dir,
    projectFile: path.join(dir, "project.json"),
    mediaDir: path.join(dir, "media"),
    exportsDir: path.join(dir, "exports"),
    analysisDir: path.join(dir, "analysis"),
  };
}

function defaultProject(name = "Untitled Project") {
  return { name, width: 1280, height: 720, fps: 30, revision: 0, media: [], clips: [] };
}

function ensureProject(id = DEFAULT_PROJECT_ID, name) {
  const p = projectPaths(id);
  for (const d of [p.dir, p.mediaDir, p.exportsDir, p.analysisDir])
    fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(p.projectFile))
    fs.writeFileSync(p.projectFile, JSON.stringify(defaultProject(name), null, 2));
  return p;
}

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(e.name))
    .map((e) => {
      const p = projectPaths(e.name);
      let doc = {};
      try { doc = JSON.parse(fs.readFileSync(p.projectFile, "utf8").replace(/^\uFEFF/, "")); } catch {}
      let modified = 0;
      try { modified = fs.statSync(p.projectFile).mtimeMs; } catch {}
      return { id: e.name, name: doc.name || e.name, revision: doc.revision || 0, modified };
    })
    .sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
}

function seedLibrary() {
  if (!SPLIT) return;
  const src = path.join(APP_DIR, "library");
  if (!fs.existsSync(src)) return;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isDirectory()) walk(a, b);
      else if (!fs.existsSync(b)) fs.copyFileSync(a, b);
    }
  };
  walk(src, LIBRARY_DIR);
}

/* One-time v1 migration. Rename instead of copying so large footage is not
   duplicated. Each successful rename removes its legacy source, so retries are
   safe after an interrupted migration. */
function migrateLegacyProject() {
  /* The checkout ships empty media/exports placeholders. They are not a legacy
     project on their own; only migrate when the old root project.json exists. */
  if (!fs.existsSync(path.join(DATA_DIR, "project.json"))) return;
  const legacy = ["project.json", "media", "exports", "analysis"]
    .map((name) => [path.join(DATA_DIR, name), name])
    .filter(([src]) => fs.existsSync(src));
  if (!legacy.length) return;
  const p = projectPaths(DEFAULT_PROJECT_ID);
  fs.mkdirSync(p.dir, { recursive: true });
  for (const [src, name] of legacy) {
    const dst = path.join(p.dir, name);
    if (!fs.existsSync(dst)) fs.renameSync(src, dst);
  }
  /* Preserve the repository's tracked placeholder directories after a
     standalone migration; user files remain in the new workspace. */
  if (DATA_DIR === APP_DIR) {
    for (const name of ["media", "exports"]) {
      const dir = path.join(DATA_DIR, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.closeSync(fs.openSync(path.join(dir, ".gitkeep"), "a"));
    }
  }
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  migrateLegacyProject();
  for (const d of LIBRARY_SUBDIRS)
    fs.mkdirSync(path.join(LIBRARY_DIR, d), { recursive: true });
  seedLibrary();
  if (!listProjects().length) ensureProject(DEFAULT_PROJECT_ID);
}

module.exports = {
  APP_DIR, DATA_DIR, SPLIT, PROJECTS_DIR, LIBRARY_DIR, LIBRARY_SUBDIRS,
  DEFAULT_PROJECT_ID, normalizeProjectId, projectPaths, ensureProject,
  listProjects, ensureDirs,
};
