---
name: tik-audio-asr
description: 将本地音频或视频语音转写为 JSON，包含文本、毫秒级时间戳和声音 ID。支持自动提取视频音轨，适用于语音转文字及发音人区分。
---

# 提客 AI 语音转文字

## 使用

1. 运行 `python3 "<skill目录>/scripts/check_environment.py"` 检查环境。需要 `TIK_API_KEY`；MP3 需要 `ffprobe`，视频还需要 `ffmpeg`。缺少所需配置或命令时，提示补齐后重试。不要读取 shell 配置寻找密钥或将密钥写入命令。
2. 将本地音频或视频的绝对路径直接传给脚本，视频会自动提取音频并清理临时文件：

   ```bash
   python3 "<skill目录>/scripts/transcribe.py" transcribe "<音频或视频绝对路径>"
   ```

   音频支持 MP3、WAV、M4A、AAC；视频支持 MP4、MOV、MKV、AVI、WebM、M4V、FLV、TS、MTS、M2TS、WMV。视频使用第一条音轨，无音轨时报告失败。
3. 成功时原样交付标准输出的 JSON；失败时依据标准错误说明原因，不暴露密钥或上传地址。

## 输出

- 链接中的 JSON 仅包含 `rich_result` 和 `channel`。`rich_result` 包含音频时长、句子和词级时间戳（均为毫秒）；`channel` 为按首次出现顺序排列的声音 ID，涵盖句子和词。原样保留结果，不把声音 ID 当作真人身份。
- 无可用结果时，`rich_result` 可为 `null`；不要补写文本或时间戳。
- 转写返回 `{"json_url":"…"}`，不展开链接内容。

需要下载已有结果时运行：

```bash
python3 "<skill目录>/scripts/download_result.py" "<json_url>" --output "<本地JSON路径>"
```

下载保留原始内容，不重复转写、不覆盖已有文件。仅支持包含 `rich_result` 和 `channel` 的结果。
