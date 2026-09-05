# tik-editvideo-cli

FableCut 的零 npm 运行时依赖命令行工具，支持启动完整编辑器服务、操作项目以及
通过无头浏览器导出最终视频。

## 环境要求

- Node.js 18+
- 快速导出需要服务端 PATH 中存在 ffmpeg
- 无头导出需要 Chrome 或 Chromium

## 安装与使用

```bash
npm install -g tik-editvideo-cli
tik-editvideo-cli server start
tik-editvideo-cli get-project --project default --compact
tik-editvideo-cli export --project default --output ./final.mp4
```

`tik-editvideo-cli server start` 默认将项目、素材、分析结果、导出文件和共享素材库保存到
`~/.fablecut/`：

```text
~/.fablecut/projects/<id>/project.json
~/.fablecut/projects/<id>/media/
~/.fablecut/projects/<id>/exports/
~/.fablecut/projects/<id>/analysis/
~/.fablecut/library/
```

可通过 `--data-dir <目录>` 或 `FABLECUT_DATA_DIR` 修改数据位置。CLI 包含自己的
Web 编辑器运行时，启动后不依赖 FableCut 源码仓库。

运行 `tik-editvideo-cli --help` 查看全部命令和参数。

## 开发阶段验证

首次在源码仓库中建立全局开发链接：

```bash
cd /path/to/FableCut/cli
npm link
```

`npm link` 会执行 `prepare`，将仓库中的服务端、Web 编辑器和资源复制到
`cli/runtime/`。全局命令链接到当前 `cli/`，因此修改 `cli/lib/` 或 `cli/bin/`
后无需再次运行 `npm link`。

如果修改了仓库根目录的 `server.js`、`app.js`、页面样式或素材库，需要刷新 CLI
自带的运行时：

```bash
cd /path/to/FableCut/cli
npm run sync-runtime
```

常用验证命令：

```bash
command -v tik-editvideo-cli
tik-editvideo-cli --help
tik-editvideo-cli server start
tik-editvideo-cli list-projects
```

启动服务后，日志中的 `app files` 应指向 `cli/runtime`，`projects` 和 `library`
应指向 `~/.fablecut`，而不是源码仓库根目录。

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
