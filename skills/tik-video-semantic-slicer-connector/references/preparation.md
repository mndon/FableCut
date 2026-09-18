# 素材准备

本 skill 只内置音视频对齐与探查工具，避免客户端依赖服务端切片 skill。转写按 [tik-audio-asr](../../tik-audio-asr/SKILL.md) 执行，工程操作按 [tik-edit-video](../../tik-edit-video/SKILL.md) 执行；不复制它们的安装、鉴权或命令手册。

CONNECTOR_DIR 为本 skill 的绝对目录；ASR_DIR 为已安装 tik-audio-asr 的绝对目录。为每轮建立独立 RUN_DIR，素材中间数据放 intermediate/s1、s2 等目录，保留原文件。准备工具需 Python 3 标准库和 ffprobe/ffmpeg。

## 统一实际素材

```bash
python3 "$CONNECTOR_DIR/scripts/prepare_video.py" "$INPUT_VIDEO" --out-dir "$RUN_DIR/intermediate/s1"
```

以 preparation.json 的 `path` 为后续转写、上传和导入的唯一素材，`probe` 指向 video_info.json。不要假定总会生成 prepared.mp4。

起点对齐的素材直接复用；否则复制视频流并裁去过早音频或补静音，统一到视频原点，尾部对齐。失败停止，不回退视频重编码。已有 ASR/工程的素材在独立检查目录加 `--existing-asr`，需要改变素材时拒绝；不能给旧 ASR 静默换源。

## 衔接转写

优先复用与实际素材绑定的本地 JSON 或 `media.asrUrl`；下载与校验使用 tik-audio-asr。下载失败或空 ASR 不自动重转，声音 ID 不认定真人。

仅需新转写时，遵循 ASR skill 的环境检查，再从 preparation.path 提取完整音频并校验，保留补入的静音：

```bash
ffmpeg -nostdin -v error -n -i "$SOURCE_PATH" -map 0:a:0 -vn -ac 1 -ar 16000 -c:a libmp3lame -q:a 4 "$RUN_DIR/intermediate/s1/audio.mp3"
python3 "$CONNECTOR_DIR/scripts/probe_video.py" "$SOURCE_PATH" --audio "$RUN_DIR/intermediate/s1/audio.mp3" --out "$RUN_DIR/intermediate/s1/audio_info.json"
```

每条命令单独检查退出码。探查通过后将此 MP3 交给 tik-audio-asr 转写，保存真实 ASR URL 并下载原 JSON，成功后清理本轮临时 MP3。客户端不分句重编号或判断商品，交给服务端处理。

## 衔接工程与上传

使用 tik-edit-video 新建本轮准备工程或复用明确指定的工程。画幅/FPS 取首个实际源的探查值；导入 preparation.path 并绑定对应 ASR URL，保存真实 media.id，读取完整 client-project.json。

按 [交换契约](exchange.md) 建立稳定 s1、s2 等源编号、media ID、准备后视频完整字节 SHA-256 和云端可读地址。只有本地 ASR JSON 时需先取得授权的可访问 URL。没有可用上传位置则保留准备成果并询问，不伪造地址。

用户时间范围只限制候选，不先裁剪素材。范围基于准备后源秒；若用户时间来自原文件，先核对原点再换算。后续不重复加减归一化偏移、不跨文件累计源时间。
