<div align="center">

<pre align="center">
███████╗ █████╗ ██████╗ ██╗     ███████╗ ██████╗██╗   ██╗████████╗
██╔════╝██╔══██╗██╔══██╗██║     ██╔════╝██╔════╝██║   ██║╚══██╔══╝
█████╗  ███████║██████╔╝██║     █████╗  ██║     ██║   ██║   ██║   
██╔══╝  ██╔══██║██╔══██╗██║     ██╔══╝  ██║     ██║   ██║   ██║   
██║     ██║  ██║██████╔╝███████╗███████╗╚██████╗╚██████╔╝   ██║   
╚═╝     ╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝ ╚═════╝ ╚═════╝    ╚═╝   
</pre>

**A browser video editor that AI agents can drive.**

<a href="https://trendshift.io/repositories/77702?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-77702" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/77702/daily?language=JavaScript" alt="ronak-create%2FFableCut | Trendshift" width="250" height="55"/></a>

[![Hacker News — front page](https://img.shields.io/badge/Hacker%20News-front%20page-ff6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/item?id=48845422)
[![DEV — Top 7 of the week](https://img.shields.io/badge/DEV-Top%207%20of%20the%20week-0A0A0A?logo=devdotto&logoColor=white)](https://dev.to/devteam/top-7-featured-dev-posts-of-the-week-815)
[![Official MCP registry](https://img.shields.io/badge/MCP%20registry-io.github.ronak--create%2Ffablecut-7b6cff?logo=modelcontextprotocol&logoColor=white)](https://registry.modelcontextprotocol.io/v0/servers?search=fablecut)
[![Mentioned in Awesome MCP Servers](https://awesome.re/mentioned-badge.svg)](https://github.com/punkpeye/awesome-mcp-servers)
[![Glama score](https://glama.ai/mcp/servers/ronak-create/FableCut/badges/score.svg)](https://glama.ai/mcp/servers/ronak-create/FableCut)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ronak-create/FableCut)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/WBKScy52F)

**English** · [简体中文](docs/i18n/README.zh-CN.md) · [日本語](docs/i18n/README.ja.md) · [Español](docs/i18n/README.es.md) · [Português (BR)](docs/i18n/README.pt-BR.md)

</div>

<https://github.com/user-attachments/assets/2430b854-168b-4a9a-af2e-489e5efa7543>

FableCut is a Premiere-style non-linear video editor that runs entirely in your
browser — and exposes its whole timeline as one JSON document. Edit it by hand,
from the UI, or let an AI agent (Claude Code, Claude Desktop, or anything that
speaks MCP/REST) cut your video for you while you watch the timeline update
live.

Projects are isolated workspaces: each gets its own `project.json`, media,
analysis cache, and exports. Use the top-bar picker, or open different
`/?project=<id>` URLs in separate tabs, to edit several projects at once.

Zero npm runtime dependencies. Run `node server.js`, or install the standalone
CLI globally and run `tik-editvideo-cli server start`.

![FableCut editor](docs/screenshot.png)

## Why it's interesting

Most "AI video" tools hide the edit behind an API. FableCut flips that: the
**project file is the interface**. `project.json` describes media, clips,
tracks, effects, keyframes and transitions — any process that can write JSON
can edit video, and the open browser UI hot-reloads within ~150 ms via
server-sent events. A human and an agent can work on the same timeline at the
same time.

## Features

**Editing**

- 3 video tracks + 4 audio tracks, drag/trim/split/snap, undo/redo
- **Settings** (cog in the top bar) — optional prefs stored in this browser via
  `localStorage`. Enable **Link timeline and Project bin selection** so picking a
  timeline clip highlights its media in Project, and clicking a Project item
  selects every timeline clip that uses it (off by default).
- **Direct manipulation on the monitor** — click a clip or title on the preview to
  move, resize (corner handles), or rotate (top handle, Shift-snap) it directly
- **Timeline multi-select** — rubber-band marquee (drag on empty track area),
  <kbd>Ctrl/Cmd/Shift+click</kbd> to add/remove clips, <kbd>Ctrl+A</kbd> to
  select all, <kbd>Esc</kbd> to deselect. Drag any selected clip to move the
  whole group; <kbd>Delete</kbd> removes all selected; <kbd>S</kbd> splits all
  selected at the playhead. Inspector shows an "N clips selected" banner.
- Beat & cue markers (tap <kbd>⇧m</kbd> on the beat during playback) with edge snapping
- Press <kbd>Alt+t</kbd> to add an in/out transition based on the playhead position over the selected clip. The last used transition is remembered as the default. Drag the overlay triangle to adjust duration; <kbd>Delete</kbd> clears the focused transition.
- Real decoded audio waveforms on clips
- **Project bin folders** — tree view with expand/collapse; drag media or folders to nest; right-click the **Project** tab → New folder; drop files onto a folder to import into it
- **Audio Hold** — timeline toolbar toggle: while paused, loops **one frame** of
  audio at the playhead (useful when stepping frame-by-frame). Scrubbing or
  frame-step retargets the held slice; meters stay live. **Play** / **Pause**
  turns it off.
- Canvas aspect presets (16:9, 9:16 reels, 4:5, 1:1) + project FPS select
  (24 / 25 / 30 / 50 / 60; non-preset rates show as Custom) + safe-area guides
- **Program Monitor zoom** — mouse-wheel over the preview zooms the composition
  toward the cursor (fit → up to **2 screen pixels per canvas pixel**). Magnified
  view uses **native scrollbars** so overflow stays reachable; middle-click or
  <kbd>Alt</kbd>+drag pans. The **Fit** button (shown while zoomed) resets to the
  fit-to-stage baseline
- Preview playback speed — shuttle the monitor through 1×/1.5×/2×/4× with **J**/**K**/**L**
  (from a stop <kbd>J</kbd>/<kbd>L</kbd> start playback; while playing <kbd>L</kbd> steps faster
  and <kbd>J</kbd> slower, <kbd>K</kbd> toggles play/pause and resets to 1×); affects the
  preview player only, never the export
- Resizable workspace: drag the divider between monitor and timeline (double-click resets), plus S/M/L timeline track-density presets (S hides thumbnails for compact tracks)
- **Zoom to selection** (<kbd>⇧Z</kbd>) frames all selected clips, not just one
- **IN/OUT work area** — set markers with <kbd>i</kbd> and <kbd>o</kbd> (<kbd>⇧I</kbd> / <kbd>⇧O</kbd> to clear). Enabling **Limit** constrains playback to the marked range and maps <kbd>Home</kbd> / <kbd>End</kbd> to the IN and OUT positions rather than the full timeline. <kbd>t</kbd> splits clips at the markers; <kbd>⇧t</kbd> trims clips to the work (between marker in and marker out) area.
- **Find & close gaps** — a gap is a stretch where every enabled track is empty (black frames). <kbd>g</kbd> jumps the playhead to the next shared gap (wraps; respects IN/OUT when both are set). <kbd>⇧G</kbd> closes the gap under the playhead by pulling later clips left on all enabled tracks.
- **Reset a property** — <kbd>Ctrl/Cmd+click</kbd> an inspector **label** to restore that effect/prop to its default (paired fields like Crop L/R reset together). Matching keyframes for the prop are cleared too; transition labels clear the in/out transition.
- **Replace media** — the inspector's **Source** button (any video/audio/image/svg
  clip) swaps the underlying file while keeping position, trim, keyframes,
  transitions and every effect. Pick another item already in the bin or
  **Browse file…** to import and replace in one step. A video's linked L/R
  audio companions are swapped along with it; a shorter replacement clamps the
  trim to fit and toasts that it did so.
- **Multi-channel video audio** — a video with more than 2 audio channels gets
  a linked audio clip per channel, not just L/R (5.1, 7.1…). Extra audio
  tracks (A5, A6, …, capped at 16) are created automatically as needed;
  replacing a clip's media re-syncs the linked channel clips to the new
  source's channel count, adding/dropping extras and new tracks as needed.

**Look**

- 14 one-click filter presets (cinematic, teal-orange, noir, vintage, cyberpunk, sunset, midnight…)
- **Adjustment layers** — one clip grades everything below it, Premiere-style
- Full grade controls: brightness/contrast/saturation/hue, **temperature & tint**,
  blur, grayscale/sepia/invert, **vignette**, animated **film grain**
- Blend modes (screen, multiply, overlay…), fit modes (contain/cover/stretch),
  per-edge cropping, corner radius, flip H/V
- **Chroma key** (green screen) with tolerance/softness + spill suppression
- **AI background removal** (person cut-out, in-browser via MediaPipe)

**Motion**

- Keyframe animation on ~25 properties with easing
- **Keyframe markers on clips** — diamonds on the clip body at each unique
  keyframe time (tooltip lists channels; a count badge when several share a
  time). <kbd>Ctrl/Cmd+←</kbd> / <kbd>Ctrl/Cmd+→</kbd> jumps the playhead to
  the previous / next keyframe (selected clips first, else clips under the
  playhead)
- **Keyframe graphs** — toggle a property’s curve in the inspector to show an
  interpolated value graph beside the program monitor; click the graph to seek
- **Speed ramps** — keyframe `speed` and the engine time-remaps video *and* the
  export audio mix (the fast-into-slow-mo reel move)
- **Camera shake** and **RGB-split/chromatic aberration**, both animatable
- 17 transitions: fades, slides, wipes (4 directions), zoom, iris, spin, blur,
  whip-pan, **glitch**, **pop**

**Text**

- **Title styles** — one-tap cohesive looks (Impact, Elegant, Kinetic cut, Neon,
  Handwritten, Luxury, and more); new titles vary the font, placement and animation
  automatically instead of defaulting to one flat style
- Kinetic captions: typewriter, word-pop, word-slide, karaoke, **letter-pop**,
  **wave**, **bounce**, **shake**, **clip-reveal**, **zoom-in**, **font-cut**
  (rhythmic typeface cuts), **rise-mask**
- **Neon glow** for that TikTok caption look
- Font editor: system fonts, drop-in custom fonts (`library/fonts/`), and **any
  Google Font by name** — loaded automatically
- Gradient fills, outline, background pills, letter-spacing, line-height,
  weights, italic, uppercase, soft shadows
- **Text layout** — horizontal Align: left / center / right / **justify**
  (extra spaces between words). Drag a title’s corner handles to create a
  **text box** (`boxW` / `boxH`); further corner drags resize it (opposite
  corner stays fixed; <kbd>Ctrl/Cmd</kbd> resizes from center; <kbd>Shift</kbd>
  locks aspect). Inside a box, text wraps at the fixed font size by default;
  enable **Scale to fit** to shrink the font so the whole block fits. **V-align**
  (top / middle / bottom) places the text block vertically in the box. Set Box
  W/H to `0` to return to hug-content sizing.

**Animated SVG clips**

- A first-class `svg` clip kind: CSS-`@keyframes`-animated SVGs render
  **frame-accurately** in preview and export (the compositor freezes the
  animation at any time). Agents can author their own vector overlays —
  lower-thirds, confetti, sparkles — as plain `.svg` files. Starters included.

**Remake a reference video**

- Give it a reference edit (a reel you like) and get back an **edit blueprint**:
  shot boundaries, music beats + BPM, a loudness curve, per-shot energy, the
  drop — plus the reference's **music track extracted** into your media, ready
  to rebuild the same idea with your own footage. Zero extra dependencies
  (ffmpeg does the decoding; onset/tempo detection is plain Node).
  `node analyze.js ref.mp4`, `POST /api/analyze`, or the
  `fablecut_analyze_reference` MCP tool.

**Asset library**

- `library/` folders surface as tabs in the UI: **Elements** (overlay art),
  **Sound FX**, **SVG** — drop files in, the open editor refreshes live

**Export**

- Fast export: browser renders every frame + an offline audio mix, ffmpeg
  encodes a frame-accurate CRF-18 MP4 (keeps rendering if you switch tabs)
- Realtime MediaRecorder fallback when ffmpeg isn't available
- Opt-in **Optimized (ffmpeg + frame cache)**: native-timestamp source frame
  caching and an ordered, bounded upload pipeline; requires ffmpeg + ffprobe.
  Fast and Realtime remain available, with the existing defaults.

## Quick start

```bash
git clone https://github.com/ronak-create/FableCut.git
cd FableCut
node server.js        # → http://localhost:7777
```

Requirements: **Node 18+** and a Chromium-based browser. **ffmpeg on PATH** is
optional but recommended (fast export + upload remuxing). AI background
removal fetches its model from a CDN on first use.

The server binds **127.0.0.1 only** (v1.3.1+). To use it from another device on
your LAN, opt in explicitly: `HOST=0.0.0.0 FABLECUT_ALLOWED_HOSTS=<your-ip> node server.js`.

Create or select a project, drop media into the window, drag clips onto the timeline, edit,
export.

Each project lives under `projects/<id>/` with its own `project.json`, `media/`,
`exports/`, and `analysis/`; `library/` is shared. To keep all work outside the
checkout, set **`FABLECUT_DATA_DIR`**. Existing single-project data is migrated
once to `projects/default/`.

### Or install it as a Claude Code plugin

```
/plugin marketplace add ronak-create/FableCut
/plugin install fablecut@fablecut
```

That registers the MCP server for you and adds the local `edit-video` and
`remake-reel` skills. Your timeline and footage live in the plugin's own data
directory, so an update never touches them. Node 18+ and (optionally) ffmpeg
still need to be on your machine.

### Cloud semantic slicing

The `tik-video-semantic-slicer-connector` skill connects local preparation to
`tik-video-semantic-slicer` on an Aliyun Managed Agent. Users work with it as a
video slicing editor: choose a product, hook and selling points, then preview
and refine the cut. The client installs the connector, `tik-edit-video` and
`tik-audio-asr`; the server installs `tik-video-semantic-slicer` and
`tik-edit-video`. The connector keeps media preparation and transport helpers,
delegating ASR and editor operations to their respective skills. It sends a native
FableCut `project.json` with a separate request, receives the edited project and
result receipt, restores local media references, and opens the client preview.
Run/input hashes and client revision checks prevent importing another job's
result or overwriting edits made while the cloud agent was working. The project
schema and preview/export compositor are unchanged. See
[the connector skill](skills/tik-video-semantic-slicer-connector/SKILL.md) for
dependencies and the session/file workflow.

### Or install the command-line interface

The standalone npm package edits local projects without an HTTP server and
starts the browser editor only when a preview or export is needed:

```bash
npm install -g tik-editvideo-cli
tik-editvideo-cli create-project --name "My Edit" --id my-edit
tik-editvideo-cli get-project --project my-edit --compact
tik-editvideo-cli status --project my-edit
# When the final video is requested:
tik-editvideo-cli export --project my-edit --output ./final.mp4
```

`list-projects`, `create-project`, `get-project`, `patch-project`, `set-project`,
and `import-media` operate directly on local workspaces. Explicit project IDs
keep parallel edits isolated. CLI, browser/API, and MCP project writes share
per-project locks and atomic saves; stale full-document replacements are rejected.

Storage is fixed at `.tik-editvideo-cli` inside the OS user home directory,
resolved with Node's `os.homedir()` on Windows, macOS, and Linux. Typical paths
are `C:\Users\<user>\.tik-editvideo-cli`, `/Users/<user>/.tik-editvideo-cli`, and
`/home/<user>/.tik-editvideo-cli`. The CLI does not accept `--data-dir` and ignores
`FABLECUT_DATA_DIR`; standalone server/MCP configuration is unchanged. On first
use, an existing `~/.fablecut` is renamed if the new directory does not exist;
neither directory is overwritten or merged.

`status` starts a background server if necessary and returns its URL; with
`--project <id>` it returns `projectUrl` for that project. Repeated calls reuse
the same server. An incompatible service or different data directory on the
port produces an error. `GET /api/status` exposes the server identity, PID, and
data directory for this check. `--host` / `--port` override `HOST` / `PORT`, with
defaults `127.0.0.1:7777`. `server start` remains available for foreground use.

Export automatically starts the local service and uses the same browser
compositor as preview. It requires ffmpeg on PATH (Optimized also needs ffprobe).
Chrome no longer needs to be installed manually: selection uses `--browser` /
`CHROME_PATH`, then the managed cache, then system Chrome/Chromium. If none is
available, the CLI downloads pinned Chrome for Testing 153.0.8010.52 over HTTPS
from `https://cdn.npmmirror.com/binaries/chrome-for-testing` by default
and caches it in `~/.tik-editvideo-cli/browsers/<version>/<platform>/`. The first
download needs network access; later exports reuse it. Progress goes to stderr;
stdout remains JSON. An invalid explicit path produces an error.

Successful export output contains `ok`, `engine`, `browser` (the executable path),
`output` (the absolute MP4 path), `sizeBytes`, and `elapsedSeconds` (total export
time in seconds, rounded to milliseconds, including server/browser preparation,
rendering, file saving, metadata probing and browser cleanup). When ffprobe can read the finished
file, it also includes `durationSeconds`, `width`, `height`, and `fps`. Detailed
performance metrics and internal project URLs are omitted from CLI output.

Automatic browser setup supports macOS and Linux x64/arm64, and Windows x64/ia32.
Linux still requires Chrome system libraries; unsupported platforms can use a
compatible browser via `--browser`. Set `FABLECUT_BROWSER_DOWNLOAD_BASE_URL`
to override the default with a trusted HTTPS source retaining the
`<version>/<platform>/chrome-<platform>.zip` layout. Google's upstream base is
`https://storage.googleapis.com/chrome-for-testing-public`. Failed installs are discarded.
To reset a damaged cache, remove its version/platform directory and retry.
ffmpeg/ffprobe remain external prerequisites. The package has no npm runtime
dependencies, needs no external unzip utility, and serves its bundled editor
runtime independently of the source checkout.

The `tik-edit-video` skill delivers a preview link after verification and invites
adjustments. It exports only on an explicit request, such as “导出最终视频”.

Attach an existing speech transcript when importing footage:

```bash
tik-editvideo-cli import-media --project my-edit --path /absolute/path/intro.mp4 --asr-url "https://example.com/intro-asr.json"
```

The optional `media.asrUrl` field is preserved in `project.json`, including browser
saves and CLI project round trips. Another device can download that URL to reuse
the complete original-source ASR JSON (`rich_result` and `channel`, with
timestamps in milliseconds). `addMedia` also accepts `asrUrl`; compact CLI output
shows `asr=yes`, while full project output includes the URL. Existing projects
remain compatible. The CLI does not download transcripts; URL availability and
expiry depend on the ASR service.

## Driving it with an AI agent

Everything an agent needs is in **[CLAUDE.md](CLAUDE.md)** — the complete
schema, semantics and recipes. Point any capable model at that file and it can
operate the editor end to end.

> 📖 **Browsable docs:** for a conversational, auto-generated tour of the
> codebase — architecture, the `project.json` schema, the MCP surface — see
> **[FableCut on DeepWiki](https://deepwiki.com/ronak-create/FableCut)**. Ask it
> questions about the repo in natural language.

Three equivalent control surfaces:

1. **MCP** (best for Claude Code / Claude Desktop) — register the bundled
   zero-dependency MCP server once:

   ```bash
   claude mcp add -s user fablecut -- node "<path-to>/fablecut/mcp-server.js"
   ```

   **OpenCode** can use the same stdio server from its project or global
   `opencode.json` configuration:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "fablecut": {
         "type": "local",
         "command": ["node", "/absolute/path/to/FableCut/mcp-server.js"],
         "enabled": true
       }
     }
   }
   ```

   For another MCP client, register a local stdio server with this equivalent
   command. The exact key names vary by client, but the command and arguments
   do not:

   ```json
   {
     "name": "fablecut",
     "transport": "stdio",
     "command": "node",
     "args": ["/absolute/path/to/FableCut/mcp-server.js"]
   }
   ```

   The server is intentionally client-neutral. It speaks MCP over stdio and
   does not require Claude-specific environment variables. Keep the path
   absolute, and use Node 18 or newer.

   Tools: `fablecut_status` (auto-starts the editor), `fablecut_docs`,
   `fablecut_list_projects`, `fablecut_create_project`, `fablecut_select_project`,
   `fablecut_get_project`, `fablecut_set_project`, `fablecut_patch_project`,
   `fablecut_import_media`, `fablecut_analyze_reference`.

   FableCut is also published on the **official MCP registry** as
   [`io.github.ronak-create/fablecut`](https://registry.modelcontextprotocol.io/v0/servers?search=fablecut)
   — each release ships an MCPB bundle (`fablecut.mcpb`) that MCPB-capable
   clients can install directly.

   The surface is **token-efficient by design**: agents patch the timeline with
   small ops (`fablecut_patch_project`) instead of round-tripping the whole
   document, read a compact one-line-per-clip summary
   (`fablecut_get_project {compact:true}`), and fetch only the manual sections
   they need (`fablecut_docs {section:"props"}`).
2. **The file** — read `projects/<id>/project.json`, modify, bump `revision`, write. The UI
   live-reloads.
3. **REST** — list/create with `GET/POST /api/projects`; project-scoped calls use
   `?project=<id>` on `GET/PUT /api/project`, `POST /api/upload`, and `/api/events`.
   See CLAUDE.md for the full list.

Example: ask Claude Code *"cut these six clips to the beat markers, add a
teal-orange grade, put a word-pop caption on top and a whoosh on every cut"* —
and watch the timeline rebuild itself.

Or hand it a reference: *"here's a reel I like — analyze it and remake it with
my clips, same music"*. The agent calls `fablecut_analyze_reference`, gets the
blueprint (cuts, beats, BPM, energy, drop, extracted music), and rebuilds the
structure shot-for-shot with your footage.

**Conflict-safe concurrent editing**: the UI, the MCP tools, and direct
`project.json` writes all agree on a `revision` counter. If you edit a clip in
the UI while an agent is mid-task, the agent's next write is rejected (409 from
the REST API / a conflict error from `fablecut_set_project`) instead of
silently overwriting your change. The UI similarly detects when an agent write
supersedes a not-yet-saved local tweak and tells you with a toast instead of
dropping it silently.

## Project layout

```
server.js        zero-dependency HTTP server: static hosting, REST API, SSE,
                 ffmpeg export pipeline
app.js           the editor: timeline UI, compositor, keyframes, text engine,
                 SVG rasterizer, chroma key, exporters
index.html       single-page UI
style.css        dark editor theme
mcp-server.js    stdio MCP server exposing the editor to AI agents
analyze.js       reference-video analyzer: shots, beats/BPM, energy, drop,
                 music extraction (module + CLI)
cli/             publishable tik-editvideo-cli npm package
CLAUDE.md        the agent manual (schema + recipes) — also served by fablecut_docs
projects/        independent project workspaces (gitignored)
  <id>/project.json  timeline
  <id>/media/        project footage
  <id>/analysis/     cached edit blueprints
  <id>/exports/      finished renders
library/         default assets: elements/ sfx/ svg/ fonts/
```

## Authoring animated SVG overlays

SVGs animate with plain CSS `@keyframes`. One convention: never hardcode
`animation-delay` — set `--d: 0.4s` instead, and the compositor drives time by
pausing all animations and rebasing their delays. Full rules + a skeleton in
[CLAUDE.md](CLAUDE.md#authoring-animated-svgs-the-svg-clip-kind); working
examples in [`library/svg/`](library/svg/).

## Notes

- The repo ships with **20 Google Fonts** (`library/fonts/`, OFL — see
  `LICENSES.md` there) and a set of self-authored SVG overlays and animated
  elements (`library/elements/`, `library/svg/`, MIT like the rest of the repo).
- `library/sfx/` is yours to fill (gitignored): sound-effect sites typically
  don't allow redistributing their files in a public repo, so FableCut doesn't —
  `library/sfx/README.md` lists good free sources.
- Export runs in the browser because the compositor *is* the browser; agents
  ask you to click Export (or render directly with ffmpeg from `media/`).

## Community

Questions, ideas, showing off an edit, or want to help shape what's next? Join
the **[FableCut Discord](https://discord.gg/WBKScy52F)**. Bugs and feature
requests are still best filed as [GitHub issues](https://github.com/ronak-create/FableCut/issues).

## License

[MIT](LICENSE)

### Optimized export

Select **Optimized (ffmpeg + frame cache)** in Export, or run:

```bash
tik-editvideo-cli export --project my-edit --engine optimized --output ./final.mp4
```

`--engine fast` remains the CLI default. Optimized uses the same browser
compositor, offline audio mix and output settings as Fast. It pre-decodes local
SDR constant-frame-rate video into five-second, lossless PNG cache blocks,
selecting native display timestamps for fixed-speed clips. Small millisecond
timestamp jitter is accepted without rounding frames to an ideal grid.
Read-ahead prepares upcoming cuts as well as the active clip; future-frame
prefetch uses two bounded background slots and never makes the current frame
wait for the entire future-frame window or an unfinished future source block.
Unsupported or
uncertain sources (including HDR, substantial variable frame rate, unspecified color matrices, rotation, non-square
pixels and speed ramps) retain browser seeking; cache failures also fall back.
No project schema changes, new npm dependencies or hardware encoder are needed.

Reusable, content-addressed source frames live in each project's `.export-cache/`
with a 2 GiB disk budget and LRU eviction of unused blocks during extraction.
Decoded images have
a 128 MiB budget, allowing current-frame requirements to exceed it. JPEG uploads
stay ordered and bounded at four frames or 32 MiB. Completed caches survive
exports; cancelled and expired sessions release their workers and leases.
Worker JPEG encoding overlaps preparation/compositing of subsequent frames,
with at most two immutable snapshots (reduced to one above a 64 MiB RGBA
snapshot budget; one oversized frame is allowed and browser overhead is extra).
If the worker fails, Canvas encodes the original snapshot. Browsers without
worker encoding retain the sequential Canvas path.
Optimized also limits FFmpeg's output color-conversion filter to one thread,
leaving CPU capacity for browser decoding and x264 without changing quality.
Final audio muxing preserves every submitted video frame, including the tail
when the timeline duration is not an exact multiple of the frame interval.

The UI shows export phases and completion time. The completion status API includes `metrics` with
phase timings, cache hits/misses, compatibility fallback reasons, resource
high-water marks and total time. Initial preparation can outweigh the benefit
on short projects; repeat exports reuse source frames. See [CLAUDE.md](CLAUDE.md#optimized-export-opt-in)
for cache API details and reproducible browser/performance tests.
Source fetch/decode, snapshot and pipeline timings are measured separately;
they overlap and should not be summed as total export time.
