---
name: tik-edit-video
description: 使用 tik-editvideo-cli 剪辑视频，支持素材导入、时间线编辑、预览和导出。适用于创建或修改视频剪辑项目。
---

# 使用 tik-editvideo-cli 剪辑视频

使用全局安装的 `tik-editvideo-cli` 进行剪辑和导出操作；本 skill 不内置 CLI。

## 初始化 CLI

每次执行本 skill 时，先检查 CLI；仅在命令不存在时通过 npm 全局安装：

```bash
if ! command -v tik-editvideo-cli >/dev/null 2>&1; then
  npm install -g tik-editvideo-cli
fi
```

若 `npm` 不存在，停止并报告；命令执行失败按下述约束处理。

## 执行约束

- 剪辑和导出仅通过 `tik-editvideo-cli` 执行，不检查或修改其实现。
- CLI 或自动安装命令返回非零退出码时，立即停止并向用户报告原始错误。不要调试或修复 CLI，不要改用 MCP、直接 HTTP 请求或其他方式绕过失败。
- 剪辑直接操作本地项目，无需启动 HTTP 服务；交付预览时通过 `status` 启动或复用服务。
- 需要 schema、属性、时间语义或剪辑配方时，只读取 [剪辑参考](references/editing-guide.md) 中与当前任务相关的章节。

## CLI 命令

统一调用方式：

```bash
tik-editvideo-cli <命令> <参数>
```

- `create-project`：创建项目。
  - `--name <名称>`：必填，项目显示名称。
  - `--id <ID>`：可选，稳定的小写项目 ID。
  - 返回新项目的 `id` 和 `name`。
- `get-project`：读取项目时间线。
  - `--project <ID>`：必填，目标项目 ID。
  - `--compact`：可选，返回低 token 的素材和片段摘要；省略时返回完整项目 JSON。
- `patch-project`：批量修改最新项目，同一项目的并发修改按顺序执行。
  - `--project <ID>`：必填，目标项目 ID。
  - `--ops '<JSON数组>'`：必填，按顺序执行的 patch 操作。
- `set-project`：替换完整项目 JSON。
  - `--project <ID>`：必填，目标项目 ID。
  - `--document '<JSON对象>'`：必填，基于最近一次完整读取修改后的项目文档。
  - `--force`：可选，仅在用户明确要求丢弃并发修改时使用。
- `import-media`：导入本地素材并注册到项目。
  - `--project <ID>`：必填，目标项目 ID。
  - `--path <绝对路径>`：必填，本地视频、音频、图片或 SVG 文件。
  - `--asr-url <URL>`：可选，原始素材完整 ASR JSON 的 HTTP(S) 地址，保存为 `media.asrUrl`，随工程交付供其他设备复用。
  - 返回可供片段引用的 `media` 对象。
- `status`：检查本地 HTTP 服务，未启动时自动启动。
  - `--project <ID>`：可选，指定时返回该项目的 `projectUrl`，用于交付预览。
- `export`：自动启动所需服务，用无头 Chrome/Chromium 调用与预览相同的浏览器合成器，导出最终 MP4。
  - `--project <ID>`：必填，目标项目 ID。
  - `--output <路径>`：可选，本地输出文件；默认使用项目名。
  - `--name <名称>`：可选，服务端导出名称。
  - `--force`：可选，覆盖已存在的本地输出文件。
  - `--browser <路径>`：可选，指定 Chrome/Chromium。
  - `--timeout <秒>`：可选，默认 3600 秒。
- `--help`：查看命令或子命令帮助。

`patch-project` 支持以下操作：

- `addClip`：添加片段；可省略 `clip.id`。
- `updateClip`：用 `id` 定位并通过 `set` 更新；`props` 按键合并。
- `removeClip`：用 `id` 删除片段。
- `addMedia`：注册已有远程素材，可在 `media.asrUrl` 附带 ASR 结果地址；本地文件优先使用 `import-media`。
- `removeMedia`：删除未被片段引用的素材记录。
- `setProject`：修改 `name`、`width`、`height`、`fps`、`background`、`markers`、`disabledTracks`。

在 `set` 中把字段设为 `null` 可删除该字段。`keyframes`、`transitionIn`、`transitionOut` 等顶层对象会整体替换，只有 `props` 按键合并。

## workflow工作流

### 1. 创建或确定项目

- 用户指定已有项目 ID 时，使用该 ID，并先运行 `get-project --compact` 确认目标项目。
- 用户要求新建项目或没有可用项目时，运行 `create-project`，记录返回的项目 ID。不要猜测已有项目 ID。

```bash
tik-editvideo-cli create-project --name "产品短片" --id product-reel
tik-editvideo-cli get-project --project product-reel --compact
```

### 2. 导入素材并完成剪辑

先读取紧凑时间线，确认素材、片段 ID、轨道和时长。逐个运行 `import-media` 导入本地素材，记录返回的 `media.id`。

已有 ASR URL 时随导入传入 `--asr-url`。需要转写内容时，先读取完整工程中的对应 `media.asrUrl` 并下载复用；紧凑摘要的 `asr=yes` 仅提示结果存在。链接内容包含 `rich_result` 和 `speaker_mapping`，时间戳基于原始素材、单位毫秒。下载失败时报告，不自动重复转写。

```bash
tik-editvideo-cli import-media --project product-reel --path /absolute/path/intro.mp4 --asr-url "https://example.com/intro-asr.json"
```

根据任务读取必要的剪辑参考，规划轨道、入点、时长、效果和音频。优先用一次 `patch-project` 提交相关修改，避免中间态：

```bash
tik-editvideo-cli patch-project --project product-reel --ops '[
  {"op":"addClip","clip":{"kind":"video","mediaId":"m_demo","track":"V1","start":0,"in":0,"duration":5,"props":{"fit":"cover"}}},
  {"op":"addClip","clip":{"kind":"text","mediaId":null,"track":"V2","start":0.4,"in":0,"duration":2.5,"props":{"text":"现在开始","font":"Anton","fontSize":96,"textAnim":"word-pop"}}}
]'
```

仅在必须替换整个文档时使用 `set-project`。先完整读取项目，再基于该 revision 修改；不要从过期文档覆盖项目。

### 3. 验证并交付

再次运行 `get-project --compact`，核对总时长、轨道、素材引用和片段边界；关键帧和转场需读取完整项目核对。验证后运行：

```bash
tik-editvideo-cli status --project product-reel
```

使用返回的 `projectUrl` 交付预览，默认不直接导出。简述剪辑结果，并提示：“可以继续提出调整，或回复‘导出最终视频’进行导出。”不展示与用户无关的内部细节。

用户回复“导出最终视频”或已明确要求最终文件时，运行：

```bash
tik-editvideo-cli export --project product-reel --output ./product-reel.mp4
```

## 剪辑原则

- 满足 `in + duration × speed ≤ media.duration`；变速关键帧需按速度积分检查源素材消耗。
- 视频画面放 V1，标题、叠加和调整层放更高视频轨；音乐、对白和音效使用音频轨。
- 相关修改合并到一次 patch，避免多次往返和中间态。
- 字幕与标题按用途选择字体，不要整条片重复同一种展示字体。
- 交付前检查画幅、FPS、响度、字幕安全区、空隙和片尾音频淡出。
- 最终导出需要本机 PATH 中有 ffmpeg，并安装 Chrome/Chromium；
  CLI 会无头驱动浏览器合成器，不要另写 ffmpeg 时间线替代它。
