# tik-editvideo-cli

FableCut 的零 npm 运行时依赖命令行工具，支持直接操作本地项目、按需启动预览服务以及
通过无头浏览器导出最终视频。

## 环境要求

- Node.js 18+
- 快速导出需要本机 PATH 中存在 ffmpeg
- 无头导出需要 Chrome 或 Chromium

## 安装与使用

```bash
npm install -g tik-editvideo-cli
tik-editvideo-cli create-project --name "产品短片" --id product-reel
tik-editvideo-cli get-project --project product-reel --compact
tik-editvideo-cli status --project product-reel
# 用户明确要求导出后：
tik-editvideo-cli export --project product-reel --output ./final.mp4
```

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

项目创建、读写和素材导入不启动 HTTP 服务。编辑时显式指定 `--project <ID>`，
可同时操作多个独立项目；同项目修改使用共享锁及原子写入，过期的完整工程保存会报冲突。
`import-media` 直接复制本地素材；有 ffprobe 时会补充时长和尺寸。

`status [--project <ID>]` 检查并按需启动后台服务，返回 JSON 中的 `url`；指定项目时
还返回 `projectId` 和 `projectUrl`。已有服务必须匹配当前工作区，否则报错。
重复调用不会重复启动服务；`server start` 保留前台启动方式。
`status`、`server start` 和 `export` 支持 `--host` / `--port`，优先于 `HOST` / `PORT`，
默认 `127.0.0.1:7777`。`export` 自动启动服务，使用与预览相同的浏览器合成器。

默认交付项目预览，用户明确要求后再导出最终视频。

从旧版本首次使用时，如果 `~/.tik-editvideo-cli` 尚不存在但 `~/.fablecut`
存在，CLI 会将旧目录一次性重命名到新位置。若两个目录都已存在，则不会自动覆盖或合并。

运行 `tik-editvideo-cli --help` 查看全部命令和参数。

导入素材时可附带已有 ASR 结果地址：

```bash
tik-editvideo-cli import-media --project default --path /absolute/path/intro.mp4 --asr-url "https://example.com/intro-asr.json"
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
tik-editvideo-cli export --project product-reel --engine optimized --output ./final.mp4
```

默认仍为 `--engine fast`。新增方式需要 ffmpeg、ffprobe 和 Chrome/Chromium，
使用与预览相同的合成器，缓存普通本地 SDR 固定帧率视频的素材帧，并按顺序流水线上传。
变速曲线、HDR 等未验证素材继续使用浏览器定位；缓存容量不足或抽帧失败也会回退。
输出 JSON 附加 `metrics`，包含阶段耗时、缓存命中、兼容回退原因和资源使用统计。
缓存位于项目 `.export-cache/`，磁盘预算为 2 GiB；第二次导出可复用，
首次准备成本可能使短项目收益有限。原 Fast 和浏览器 Realtime 不受影响。
