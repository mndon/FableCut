---
name: tik-audio-asr
description: 将本地音频或视频语音转写为 JSON，包含文本、毫秒级时间戳和发音人映射。用于影片或音频的语音转文字及发音人区分。
---

# 提客 AI 语音转文字

## 执行

1. 运行 `python3 "<skill目录>/scripts/check_environment.py"`，仅报告凭据是否配置与命令是否存在。`TIK_API_KEY` 缺失时停止转写，提示用户修复运行环境后续跑；不要搜索、读取或打印 shell 配置来找密钥，也不要把密钥写进命令。此检查不加载 shell 配置，不判断模型视听能力。已泄露的密钥须由用户在服务端撤销/轮换，并处理共享记录；不能把修改本地配置称为撤销成功。
2. 准备绝对路径的本地音频。支持 `.mp3`、`.wav`、`.m4a` 和 `.aac`。
3. 若输入是视频，使用 `ffmpeg` 提取为临时 MP3 后再转写：

   ```bash
   ffmpeg -y -i "<视频绝对路径>" -vn -ac 1 -ar 16000 -c:a libmp3lame -q:a 4 "<临时音频绝对路径>.mp3"
   ```

   仅在转写完成后删除该临时文件；若系统没有 `ffmpeg`，说明无法在当前环境提取音频。
4. 用户或调用方明确要求以 JSON URL 交付时使用 `--return-mode 1`；否则使用 `0`（默认）：

   ```bash
   python3 "<skill目录>/scripts/transcribe.py" transcribe "<音频绝对路径>" --return-mode 0
   ```

5. 成功时，原样返回标准输出中的唯一 JSON 对象。失败时，依据标准错误的 JSON 错误说明问题，且不得暴露 API Key、上传地址或其他凭据。

## 输出

模式 `1` 原样交付 `{"json_url":"https://example.com/result.json"}`，不展开链接内容。链接中的 JSON 与模式 `0` 的结果结构一致。模式 `0` 返回：

- `rich_result.duration`：音频总时长，单位为毫秒。
- `rich_result.sentences`：按时间顺序排列的句子；每项包含 `begin_time`、`end_time`（毫秒）、`text`、`channel_id` 和 `words`。
- `words`：词级时间戳；每项包含 `begin_time`、`end_time`（毫秒）、`word`、其后标点 `punc` 和 `channel_id`。
- `speaker_mapping`：以字符串形式的 `channel_id` 为键、发音人名称为值的映射。

示例：

```json
{
  "rich_result": {
    "duration": 3101,
    "sentences": [
      {
        "begin_time": 1100,
        "end_time": 2330,
        "text": "北京的天气。",
        "channel_id": 0,
        "words": [
          {"begin_time": 1100, "end_time": 1570, "word": "北京", "punc": "", "channel_id": 0},
          {"begin_time": 1570, "end_time": 1700, "word": "的", "punc": "", "channel_id": 0},
          {"begin_time": 1700, "end_time": 2330, "word": "天气", "punc": "。", "channel_id": 0}
        ]
      }
    ]
  },
  "speaker_mapping": {"0": "说话人1"}
}
```

只将受支持的音频路径传给转写脚本，不要直接传入视频路径。原样保留结果，不要重建、补全或伪造时间戳和发音人信息。

调用方需要读取已有 JSON URL 时，可运行 `python3 "<skill目录>/scripts/download_result.py" "<json_url>" --output "<本地JSON路径>"`。它保存原始内容，不重复转写、不覆盖已有文件；下载失败时报告问题。
