# tik-editvideo-cli

FableCut 的零 npm 运行时依赖命令行工具，支持直接操作本地项目、按需启动预览服务以及
通过无头浏览器导出最终视频。

## 环境要求

- Node.js 18+
- 快速导出需要本机 PATH 中存在 ffmpeg
- Optimized 导出还需要本机 PATH 中存在 ffprobe
- 无头导出自动准备 Chrome，无需手动安装；首次下载需要联网
- Linux 仍需具备 Chrome 运行所需的系统库

## 安装与使用

```bash
npm install -g tik-editvideo-cli
tik-editvideo-cli create-project --name "产品短片"
tik-editvideo-cli get-project --project-id <返回的project_id> --compact
tik-editvideo-cli status --project-id <返回的project_id>
# 用户明确要求导出后：
tik-editvideo-cli export --project-id <返回的project_id> --output ./final.mp4
```

`create-project --name <语义名称>` 按本机当天日期生成 `YYYYMMDD_语义名称`，
自动生成无横杠的 UUID v4 项目 ID（32 位小写十六进制字符串），返回 `{project_id, name}`。不支持 `--id`，后续命令使用返回的
`project_id`；已有项目的名称和 ID 保持不变。
项目参数为 `--project-id <ID>`。

CLI 将项目、素材、分析结果、导出文件和共享素材库固定保存到
`~/.tik-editvideo-cli/`：

```text
~/.tik-editvideo-cli/projects/<id>/project.json
~/.tik-editvideo-cli/projects/<id>/media/
~/.tik-editvideo-cli/projects/<id>/exports/
~/.tik-editvideo-cli/projects/<id>/analysis/
~/.tik-editvideo-cli/library/
```

目录通过 `path.join(os.homedir(), ".tik-editvideo-cli")` 解析，支持 Windows、macOS
和 Linux。典型路径分别为 `C:\Users\<用户>\.tik-editvideo-cli`、
`/Users/<用户>/.tik-editvideo-cli`、`/home/<用户>/.tik-editvideo-cli`。
`--data-dir` 不再支持，外部 `FABLECUT_DATA_DIR` 不影响 CLI。CLI 包含自己的
Web 编辑器运行时，不依赖源码仓库；独立服务和 MCP 原有目录配置保持兼容。

项目创建、读写和素材导入不启动 HTTP 服务。编辑时显式指定 `--project-id <ID>`，
可同时操作多个独立项目；同项目修改使用共享锁及原子写入，过期的完整工程保存会报冲突。
`import-media` 直接复制本地素材；有 ffprobe 时会补充时长和尺寸。

`status [--project-id <ID>]` 检查并按需启动后台服务，返回 JSON 中的 `url`；指定项目时
还返回 `projectId` 和 `projectUrl`。已有服务必须匹配当前工作区，否则报错。
重复调用不会重复启动服务；`server start` 保留前台启动方式。
`status`、`server start` 和 `export` 支持 `--host` / `--port`，优先于 `HOST` / `PORT`，
默认 `127.0.0.1:7777`。`export` 自动启动服务，使用与预览相同的浏览器合成器。

浏览器选择顺序：`--browser` / `CHROME_PATH` → 已缓存浏览器 → 系统 Chrome/Chromium。
均不可用时，CLI 默认从国内 npmmirror 镜像
`https://cdn.npmmirror.com/binaries/chrome-for-testing`
下载固定版本 Chrome for Testing 153.0.8010.52，
解压、校验并验证启动后，缓存到 `~/.tik-editvideo-cli/browsers/<version>/<platform>/`。
后续导出直接复用；下载进度写入 stderr，stdout 保持 JSON。显式路径无效时直接报错。
支持 macOS / Linux 的 x64、arm64 和 Windows 的 x64、ia32；其他平台可通过
`--browser` 指定兼容浏览器。下载、解压仅用 Node 标准库，无需 npm 依赖或解压工具。

可通过 `FABLECUT_BROWSER_DOWNLOAD_BASE_URL` 覆盖默认源，设置为其他可信 HTTPS 地址，
并保留 `<version>/<platform>/chrome-<platform>.zip` 路径结构。若需使用 Google 官方源，
将其设为 `https://storage.googleapis.com/chrome-for-testing-public`。安装失败会清理
临时文件；强制终止进程遗留的 `.install-*` 目录可手动删除。缓存损坏时删除对应
版本/平台目录后重新导出。ffmpeg / ffprobe 仍需预先安装。

导出成功后输出精简 JSON：`ok`、`engine`（导出方式）、`browser`（实际使用的 Chrome
可执行文件路径）、`output`（成片绝对路径）、`sizeBytes`（文件字节数），以及从成片读取的
`durationSeconds`（时长）、`width`、`height`、`fps`。ffprobe 不可用或读取失败时省略
时长、分辨率及帧率，仍返回成功结果和文件大小。CLI 不再输出内部资源地址及详细性能指标。
另输出 `elapsedSeconds`（导出总耗时，单位秒，保留到毫秒），包含本地服务准备、浏览器准备、
渲染、成片保存、文件信息读取和浏览器清理；与视频本身的 `durationSeconds` 区分。

默认交付项目预览，用户明确要求后再导出最终视频。

从旧版本首次使用时，如果 `~/.tik-editvideo-cli` 尚不存在但 `~/.fablecut`
存在，CLI 会将旧目录一次性重命名到新位置。若两个目录都已存在，则不会自动覆盖或合并。

运行 `tik-editvideo-cli --help` 查看全部命令和参数。

导入素材时可附带已有 ASR 结果地址：

```bash
tik-editvideo-cli import-media --project-id default --path /absolute/path/intro.mp4 --asr-url "https://example.com/intro-asr.json"
```

`--asr-url` 为可选 HTTP(S) 地址，保存为 `media.asrUrl`；`addMedia` 也支持该字段。
完整工程及浏览器保存会保留它，其他设备可下载复用 `rich_result` 与 `speaker_mapping`
（原始素材毫秒时间戳）。紧凑摘要仅显示 `asr=yes`，实际地址读取完整工程。CLI 不下载
ASR 内容，链接有效期由 ASR 服务决定；未记录 URL 的旧工程保持兼容。

## 开发阶段验证

首次在源码仓库中建立全局开发链接：

```bash
cd /path/to/FableCut/cli
npm link
```

`npm link` 会执行 `prepare`，将仓库中的服务端、Web 编辑器和资源复制到
`cli/runtime/`。全局命令链接到当前 `cli/`，因此修改 `cli/lib/` 或 `cli/bin/`
后无需再次运行 `npm link`。

如果修改了仓库根目录的 `server.js`、`app.js`、页面样式、`paths.js`、`project-store.js` 或素材库，需要刷新 CLI
自带的运行时：

```bash
cd /path/to/FableCut/cli
npm run sync-runtime
```

运行自动测试前先执行 `npm run sync-runtime`；在仓库根目录执行 `node --test tests/*.test.js`。测试使用隔离的临时用户目录。

可选的真实浏览器安装测试（需要联网、ffmpeg 和 ffprobe，无需预装 Chrome）：

```bash
FABLECUT_BROWSER_INSTALL_TEST=1 node --test --test-name-pattern='export starts the server' tests/cli-local.test.js
```

该测试跳过系统浏览器发现，将浏览器下载至隔离缓存，再验证 CLI 的 Fast / Optimized 导出。

常用验证命令：

```bash
command -v tik-editvideo-cli
tik-editvideo-cli --help
tik-editvideo-cli list-projects
tik-editvideo-cli status
```

启动服务后，日志中的 `app files` 应指向 `cli/runtime`，`projects` 和 `library`
应指向 `~/.tik-editvideo-cli`，而不是源码仓库根目录。

模拟正式发布包：

```bash
cd /path/to/FableCut/cli
npm pack
npm install -g ./tik-editvideo-cli-1.7.0.tgz
```

取消开发链接：

```bash
npm unlink -g tik-editvideo-cli
```

### Optimized 导出

```bash
tik-editvideo-cli export --project-id <返回的project_id> --engine optimized --output ./final.mp4
```

默认仍为 `--engine fast`。新增方式需要 ffmpeg、ffprobe，浏览器由 CLI 自动准备，
使用与预览相同的合成器，缓存普通本地 SDR 固定帧率视频的素材帧，并按顺序流水线上传。
变速曲线、HDR 等未验证素材继续使用浏览器定位；缓存容量不足或抽帧失败也会回退。
详细 `metrics`（阶段耗时、缓存命中、兼容回退原因和资源使用统计）保留在完成状态 API 中，
CLI 仅输出导出方式、Chrome 路径及成片基本信息。
缓存位于项目 `.export-cache/`，磁盘预算为 2 GiB；第二次导出可复用，
首次准备成本可能使短项目收益有限。原 Fast 和浏览器 Realtime 不受影响。

## CLI OpenAPI authentication

Run `tik-editvideo-cli auth status` to validate the saved API Key and return
`logged_in` plus `user_info`. A missing or rejected key returns
`{"logged_in": false}` with exit code 0. Network and service failures are errors.
Use `tik-editvideo-cli auth login` when signed out: it prints and opens a browser
login URL, polls until authorization or expiry, validates the returned key, and
saves it to `~/.tik-editvideo-cli/auth.json` with mode `0600`. Add `--no-browser`
on headless systems. Credentials are never printed. The default OpenAPI origin
is `https://app.tttci.com`; `--api-url <origin>` selects another environment and
credentials are bound to that origin. The selected origin is saved on login.
`auth logout` deletes local credentials only; revoke the key in API Key management
to invalidate it on every device. Repeated logins reuse the dedicated CLI key;
there is no per-user API Key count limit. New keys use `sk-<UUID v4><yyMMddHHmmss>`
with a Beijing-time suffix (51 characters total). Existing 64-character hex keys
remain valid and are not automatically rotated.

These commands do not start the local editor server. The existing `status`
command still controls local preview. Local editing remains available offline.

## 依赖检查、转写和通用下载

```bash
tik-editvideo-cli doctor
tik-editvideo-cli auth status
tik-editvideo-cli asr --path "/绝对路径/素材.mp4"
tik-editvideo-cli asr --path "/绝对路径/素材.mp4" --output "./audio.json"
tik-editvideo-cli download --url "https://example.com/file" --output "./file"
```

doctor 检查 Node ≥18、ffmpeg、ffprobe，输出 `{ok, checks}`；全部通过退出码为 0，失败为 1，不安装依赖或启动服务。skill 在同一任务及环境中复用已成功的 doctor 和登录检查；`auth status` 按 `logged_in` 判断。

ASR 使用 CLI 保存的登录凭据，不读取 `TIK_API_KEY`；固定访问 `https://skgw-tik.tttci.com/open`，`--api-url` 只选择凭据所属环境。支持 MP3/WAV/M4A/AAC 和 MP4/MOV/MKV/AVI/WebM/M4V/FLV/TS/MTS/M2TS/WMV；视频提取第一音轨并清理临时文件。元数据需要 ffprobe，视频提取还需要 ffmpeg。每 3 秒轮询，30 分钟超时。

省略输出时返回 `{"json_url":"…"}`；指定 `--output` 时下载并校验 rich_result/channel，保存原始字节并返回 `{"json_url":"…","path":"<绝对路径>"}`。rich_result 为 null 仍是有效结果。转写完成但保存失败的错误保留 json_url，使用 download 重试，避免重复转写。

通用 download 支持任意 HTTP(S) 文件及二进制数据，不携带登录凭据、不校验 ASR 格式；最多 5 次 HTTP(S) 重定向，下载超时 60 秒，保持 TLS 证书校验。成功返回 `{"path":"<绝对路径>"}`。两种输出都自动创建父目录、按当前目录解析相对路径、拒绝覆盖已有文件，失败清理临时文件。命令无需工程、浏览器或本地编辑服务。
