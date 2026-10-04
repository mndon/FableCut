# tik-video-editor-cli 开发与发布

本文面向源码仓库维护者。CLI 安装、命令使用和运行时行为见
[主 README](../README.md#or-install-the-command-line-interface) 和 [完整手册](../CLAUDE.md#run)。
CLI 采用 [非商业使用及商业授权协议](LICENSE)，第三方内容适用各自许可，见
[第三方声明](THIRD-PARTY-NOTICES.md)。

## 本地开发

首次在源码仓库中建立全局开发链接：

```bash
cd /path/to/FableCut/cli
npm ci --include=dev
npm link
```

`npm ci --include=dev` / `npm link` 会执行 `prepare`，同步 `cli/runtime/` 并生成 `cli/dist/`。
全局命令链接到 `cli/dist/bin/`；修改 CLI 或编辑器源码后运行 `npm run build`
刷新发布目录，无需再次运行 `npm link`。

构建需要开发依赖 Terser 和 javascript-obfuscator。若 `npm pack` 提示
`Cannot find module 'terser'`，先在 `cli/` 执行 `npm ci --include=dev`；
显式包含开发依赖可避免 `NODE_ENV=production` 或 npm 的 `omit=dev` 配置跳过它们。

如果修改了仓库根目录的 `server.js`、`app.js`、页面样式、`paths.js`、`project-store.js` 或素材库，需要刷新 CLI
自带的运行时：

```bash
cd /path/to/FableCut/cli
npm run build
```

运行自动测试前先执行 `npm run sync-runtime`；在仓库根目录执行 `node --test tests/*.test.js`。测试使用隔离的临时用户目录。

### 发布包压缩与混淆

`npm pack` / `npm publish` 自动通过 `prepare` 生成发布目录。仅发布 `dist/`、
构建脚本、package.json 和许可声明，不发布原始 `bin/`、`lib/`、
`runtime/` 或 source map。不要使用 `--ignore-scripts` 发布旧构建。
CLI JavaScript 使用 Terser 压缩，再用 javascript-obfuscator 做标识符和 Base64
字符串表混淆；编辑器、服务端、Worker 和 AudioWorklet 使用 Terser 压缩及局部
变量名缩短。浏览器脚本保留跨文件全局名称；对象属性、接口及工程字段不改名，
不启用控制流平坦化、反调试或自保护。预览和导出继续使用同一合成器。

两个工具是固定版本的开发依赖，最终 CLI 仍只有 Node 标准库运行时依赖。
安装和 `npm rebuild` 不需要构建工具；源码仓库保留可读文件及各自许可声明。
混淆提高阅读和修改成本，不提供源码保密或防复制保证。

在仓库根目录运行 `node --test tests/cli-package.test.js`，会构建真实 npm 包，
离线安装到临时目录，并对安装后的混淆代码执行本地编辑、服务、登录及下载/ASR
回归测试。有 Chrome、ffmpeg 和 ffprobe 时也验证 Fast / Optimized 成片；
`FABLECUT_BROWSER_TEST=1` 额外启用带音轨、实际视频及帧缓存的浏览器导出对比。

可选的真实浏览器安装测试（需要联网、ffmpeg 和 ffprobe，无需预装 Chrome）：

```bash
FABLECUT_BROWSER_INSTALL_TEST=1 node --test --test-name-pattern='export starts the server' tests/cli-local.test.js
```

该测试跳过系统浏览器发现，将浏览器下载至隔离缓存，再验证 CLI 的 Fast / Optimized 导出。

常用验证命令：

```bash
command -v tik-video-editor-cli
tik-video-editor-cli --help
tik-video-editor-cli list-projects
tik-video-editor-cli status
```

启动服务后，日志中的 `app files` 应指向 `cli/dist/runtime`，`projects` 和 `library`
应指向 `~/.tik-video-editor-cli`，而不是源码仓库根目录。

模拟正式发布包：

```bash
cd /path/to/FableCut/cli
npm pack
npm install -g "./tik-video-editor-cli-<当前版本>.tgz"
```

取消开发链接：

```bash
npm unlink -g tik-video-editor-cli
```

## 发布流程

在源码仓库的 `cli/` 目录执行 `npm ci --include=dev` 安装锁定版本的构建依赖，再完成上述验证。
修改版本时保持 `cli/package.json` 与 `cli/package-lock.json` 一致。
发布前，在仓库根目录执行：

```bash
node --check server.js && node --check app.js && node --check mcp-server.js
node --test tests/cli-package.test.js
```

检查实际 tarball 的文件清单：

```bash
cd /path/to/FableCut/cli
npm pack --json
```

确认包中包含 `dist/`、构建脚本、`package.json`、`LICENSE` 和
`THIRD-PARTY-NOTICES.md`，且不包含原始源码目录、source map 或开发文档。
`cli/README.md` 已移除：npm 会自动包含包根目录的 README，单纯从 `files`
白名单删除它无法排除。本文 `DEVELOP.md` 不在发布白名单中，留在源码仓库。

发布地址由 `cli/package.json` 的 `publishConfig.registry` 固定为 npm 官方仓库，
安装依赖仍可使用本机配置的镜像。发布前使用有该包发布权限的 npm 账号登录：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish
```

若遇到 `ENEEDAUTH`，检查报错中的仓库地址并重新登录官方仓库。
登录及发布过程中按 npm 提示完成浏览器认证或双因素验证。

`prepare` 会重新同步并构建运行时。不要使用 `--ignore-scripts`，以免发布旧构建。
构建保留 `cli/LICENSE` 和第三方声明，并将根目录的 MIT 许可证复制到
`dist/runtime/LICENSE`；不得覆盖 CLI 自身的许可证。

## 可选导出验证与基准

同步运行时后，可在仓库根目录比较真实 Fast / Optimized 成片：

```bash
FABLECUT_BROWSER_TEST=1 node --test tests/export-browser.test.js
```

需要 ffmpeg、ffprobe 和 Chrome，可用 `CHROME_PATH` 指定浏览器。
该测试验证视频、音轨及帧数；添加 `FABLECUT_EXPORT_BENCH=1` 可运行三轮
60 秒 1080p 冷缓存/热缓存基准，并比较中位数。临时产物和性能指标目录由测试输出。
`FABLECUT_TEST_CLI_DIR` 仅供测试指定其他 CLI 目录，不是产品设置。
