---
name: fablecut-edit-video
description: 使用 FableCut 进行视频剪辑，FableCut将所有剪辑操作维护在一份.json文件中，当剪辑操作完成可预览剪辑效果，也可以可渲染导出最终视频。本skill在用户需要视频剪辑时使用。
---

# 使用 FableCut 剪辑视频

使用本 skill 自带的 `scripts/fablecut_cli` 进行剪辑操作。

## 执行约束

- 仅运行 `scripts/fablecut_cli`，把它视为不可检查的黑盒工具。
- 不要读取、搜索、复制、解释或修改 `scripts/fablecut_cli` 的实现。
- CLI 返回非零退出码或错误时，立即停止并向用户报告原始错误。不要调试或修复 CLI，不要改用 MCP、直接 HTTP 请求或其他方式绕过失败。
- 确认环境变量 `FABLECUT_URL` 和 `FABLECUT_TOKEN` 已设置，但不要打印 Token。
- 需要 schema、属性、时间语义或剪辑配方时，只读取 [剪辑参考](references/editing-guide.md) 中与当前任务相关的章节。

## CLI 命令

统一调用方式：

```bash
python3 <skill目录>/scripts/fablecut_cli <命令> <参数>
```

- `create-project`：创建项目。
  - `--name <名称>`：必填，项目显示名称。
  - `--id <ID>`：可选，稳定的小写项目 ID。
  - 返回新项目的 `id` 和 `name`。
- `get-project`：读取项目时间线。
  - `--project <ID>`：必填，目标项目 ID。
  - `--compact`：可选，返回低 token 的素材和片段摘要；省略时返回完整项目 JSON。
- `patch-project`：批量修改最新项目，发生 revision 冲突时由 CLI 自动重试。
  - `--project <ID>`：必填，目标项目 ID。
  - `--ops '<JSON数组>'`：必填，按顺序执行的 patch 操作。
- `set-project`：替换完整项目 JSON。
  - `--project <ID>`：必填，目标项目 ID。
  - `--document '<JSON对象>'`：必填，基于最近一次完整读取修改后的项目文档。
  - `--force`：可选，仅在用户明确要求丢弃并发修改时使用。
- `import-media`：上传本地素材并注册到项目。
  - `--project <ID>`：必填，目标项目 ID。
  - `--path <绝对路径>`：必填，本地视频、音频、图片或 SVG 文件。
  - 返回可供片段引用的 `media` 对象。
- `--help`：查看命令或子命令帮助。

`patch-project` 支持以下操作：

- `addClip`：添加片段；可省略 `clip.id`。
- `updateClip`：用 `id` 定位并通过 `set` 更新；`props` 按键合并。
- `removeClip`：用 `id` 删除片段。
- `addMedia`：注册已有远程素材；本地文件优先使用 `import-media`。
- `removeMedia`：删除未被片段引用的素材记录。
- `setProject`：修改 `name`、`width`、`height`、`fps`、`background`、`markers`、`disabledTracks`。

在 `set` 中把字段设为 `null` 可删除该字段。`keyframes`、`transitionIn`、`transitionOut` 等顶层对象会整体替换，只有 `props` 按键合并。

## workflow工作流

### 1. 创建或确定项目

- 用户指定已有项目 ID 时，使用该 ID，并先运行 `get-project --compact` 确认目标项目。
- 用户要求新建项目或没有可用项目时，运行 `create-project`，记录返回的项目 ID。不要猜测已有项目 ID。

```bash
python3 <skill目录>/scripts/fablecut_cli create-project --name "产品短片" --id product-reel
python3 <skill目录>/scripts/fablecut_cli get-project --project product-reel --compact
```

### 2. 导入素材并完成剪辑

先读取紧凑时间线，确认素材、片段 ID、轨道和时长。逐个运行 `import-media` 导入本地素材，记录返回的 `media.id`。

```bash
python3 <skill目录>/scripts/fablecut_cli import-media --project product-reel --path /absolute/path/intro.mp4
```

根据任务读取必要的剪辑参考，规划轨道、入点、时长、效果和音频。优先用一次 `patch-project` 提交相关修改，避免中间态：

```bash
python3 <skill目录>/scripts/fablecut_cli patch-project --project product-reel --ops '[
  {"op":"addClip","clip":{"kind":"video","mediaId":"m_demo","track":"V1","start":0,"in":0,"duration":5,"props":{"fit":"cover"}}},
  {"op":"addClip","clip":{"kind":"text","mediaId":null,"track":"V2","start":0.4,"in":0,"duration":2.5,"props":{"text":"现在开始","font":"Anton","fontSize":96,"textAnim":"word-pop"}}}
]'
```

仅在必须替换整个文档时使用 `set-project`。先完整读取项目，再基于该 revision 修改；不要从过期文档覆盖项目。

### 3. 验证并交付

再次运行 `get-project --compact`，核对总时长、轨道、素材引用、片段边界、关键帧和转场。让用户在 `$FABLECUT_URL/?project=<项目ID>` 中预览，并在浏览器中执行导出。

## 剪辑原则

- 满足 `in + duration × speed ≤ media.duration`；变速关键帧需按速度积分检查源素材消耗。
- 视频画面放 V1，标题、叠加和调整层放更高视频轨；音乐、对白和音效使用音频轨。
- 相关修改合并到一次 patch，避免多次往返和中间态。
- 字幕与标题按用途选择字体，不要整条片重复同一种展示字体。
- 交付前检查画幅、FPS、响度、字幕安全区、空隙和片尾音频淡出。
- 导出依赖浏览器合成器，CLI 不触发导出。
