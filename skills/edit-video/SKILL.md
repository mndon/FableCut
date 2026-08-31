---
description: Produce and edit a FableCut project.json — assemble a cut, add titles and captions, grade, add transitions, keyframe animation, and speed ramps. Use whenever the user wants an MCP-driven video timeline for a FableCut-compatible client.
---

# Editing video with FableCut

FableCut's MCP service produces independent JSON timelines for client apps.
Every edit is scoped to an explicit projectId; media entries point to immutable
upstream asset IDs that the client resolves for playback.

## Start here, every time

1. Establish the projectId. Reuse the ID already in the conversation; otherwise
   call **`fablecut_create_project`** once and retain the returned ID for all
   later calls. There is deliberately no project-list tool.
2. **`fablecut_status {projectId}`** — validates access and returns the project
   summary. It does not start the legacy browser editor.
3. **`fablecut_docs`** — the full manual: `project.json` schema, every prop,
   transitions, text animations, and a recipe book. Request a single section
   (`{projectId,section:"props"}`, `{projectId,section:"Recipes"}`) rather than the whole document.
   Skip it entirely if the schema is already in context.

## Making edits

**Prefer `fablecut_patch_project`.** It sends only what changes, re-reads the
latest document internally, and is merge-safe — it will not clobber another
client's saved edit. Batch related changes into one call; ops apply in
order and bump the revision once.

```
fablecut_patch_project {projectId,ops:[
  {op:"updateClip", id:"c_v2", set:{props:{filterPreset:"teal-orange"}}}
]}
```

Use `fablecut_get_project {projectId,compact:true}` to plan — it's roughly 10× smaller
than the full JSON. Fetch the full document only when you need exact keyframes.

`fablecut_set_project` replaces the whole document and is conflict-checked: if
another client saved since the submitted revision, it refuses rather than
overwriting. On conflict, re-read, re-apply your change without manually
bumping revision, and call it again.

## Getting footage in

`fablecut_import_media {projectId,asset:{assetId,name,kind,duration?,width?,height?}}`
registers upstream asset metadata. It does not copy files or persist playback
URLs. Ask the calling application for missing asset IDs or metadata; do not pass
server-local paths.

## Things that trip people up

- A cut is just two clips: the first with `duration: t`, the second with
  `start: +t, in: +t×speed, duration: rest`.
- Video and audio clips must satisfy `in + duration×speed ≤ media.duration`.
- Crossfades are same-track overlap plus `transitionIn: {type:"fade"}` on the
  later clip — not a separate object.
- Vary the font per title. Reusing one typeface across a whole edit is the
  single clearest tell of a machine-made cut; `fablecut_docs {section:"Text"}`
  lists the built-in title styles.
- The MCP service only produces project.json. Preview and export belong to the
  independent client app that resolves assetId and implements the compositor.
