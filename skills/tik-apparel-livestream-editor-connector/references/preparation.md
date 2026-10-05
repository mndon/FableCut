# 素材准备

输入文件校验、原点对齐、重封装及转码全部由 tik-video-editor-cli import-media 完成。本 skill 只负责工程和传输数据，不内置媒体预处理工具，也不调用 ffprobe/ffmpeg。复用本任务当前环境已通过的 doctor/auth status。

每轮建立独立 RUN_DIR，中间记录放 intermediate/s1、s2 等目录。先按 [tik-video-editor](../../tik-video-editor/SKILL.md) 创建或选择工程，再导入：

```bash
tik-video-editor-cli import-media --project-id "$PROJECT_ID" --path "$INPUT_VIDEO"
```

保存完整返回值为 import.json，以 media.src 对应的本地文件路径 为转写、上传及哈希计算的唯一实际文件，media 中的 duration/width/height 为探查数据，media.id 为真实素材 ID。CLI 会将合规视频直接复制到项目目录，其他视频优先复制视频流，仅必要时转码。原文件保留，失败停止，不执行替代准备。

已有本地 ASR 时加 --asr-local-path <本地JSON路径>，有 URL 时加 --asr-url；需要改变源时间原点时 CLI 拒绝。已注册的工程素材直接复用 ID、实际文件和 asrUrl，不重新导入。旧工程缺少准备依据时，通过独立 CLI 工程、启用已有 ASR 保护校验，不能静默换源。

## 获取转写

通过下方媒体命令复用本地结果或下载已有 URL，CLI 校验 rich_result/channel；服务端数据脚本进一步检查。空结果不发起选句，下载失败不重转，声音标签不是人物身份。

需要新转写时对导入后的实际视频调用：

```bash
tik-video-editor-cli media --action asr --project-id "$PROJECT_ID" --media-id "$MEDIA_ID" --output "$RUN_DIR/intermediate/s1/audio.json"
```

CLI 负责完整音频提取、输出校验和临时文件清理。保存返回的真实 json_url 与 path；转写成功但保存失败时，再次运行同一媒体命令恢复下载与绑定，不重复转写。

CLI 自动保存 media.asrLocalPath/asrUrl；失败停止，不重复导入。后续读取完整 client-project.json，以首个实际源的宽高/FPS设置工程。

## 上传与绑定

按 [交换契约](exchange.md) 建立稳定 source ID、真实 media ID、导入后文件完整字节 SHA-256 和云端可读地址。只上传 media.src 对应的本地文件路径 指向的文件，不以原文件地址代替处理结果。仅有本地 ASR 时先取得授权的可访问 URL。没有上传位置则保留成果并询问，不伪造地址。

用户范围只限制候选，不在准备时裁剪；范围基于导入后源秒，原文件时间须根据导入记录的原点换算。后续不再次补偿偏移，也不跨文件累计源时间。

媒体转写统一使用 `media --action asr --project-id <id> --media-id <id>`。将导入返回的 `media.id` 保存为 `$MEDIA_ID`，工程 ID 保存为 `$PROJECT_ID`。命令优先复用有效 `media.asrLocalPath`，其次下载 `media.asrUrl`，无绑定才新转写；默认保存至工程 analysis/asr/，可用 --output 指定未占用路径。转写成功但下载失败时 URL 已保存，再次运行同一媒体命令继续下载，不重新转写。只有本地结果时 json_url 可缺省，不伪造 URL。新结果自动绑定，不再手动替换工程；跨设备本地路径不可用时按 URL 恢复。

实际文件路径解析：将 `media.src` 按路径段 URL 解码后拼接到 CLI 数据目录 `~/.tik-video-editor-cli/` 下。`import-media` 不返回 `preparation`；探查记录只保存 `media` 的 duration/width/height。
