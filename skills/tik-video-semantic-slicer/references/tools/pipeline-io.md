# 数据与转写契约

所有脚本路径相对于本 skill。命令示例中的 `SKILL_DIR`、`RUN_DIR` 由调用者设置为绝对路径；不能把当前 shell 目录当成技能根。源视频不覆盖，中间产物写入独立 run。

## 文件与时间基准

- `intermediate/sources.json`：原始素材、原始 ASR 文件、候选范围、导入后的素材 ID。素材顺序就是跨文件源顺序。
- `intermediate/s1/video_info.json`、`audio_info.json`、`audio.json`：每个素材的探查记录与原始转写；临时 `audio.mp3` 转写成功后按 tik-audio-asr 清理。
- `intermediate/sentences.json`、`speakers_summary.json`：稳定全量短语和说话人摘要；说话人筛选通过配置中的 allowed_speakers 控制。
- `intermediate/keep_selection.json`、`edit_config.json`：索引选择与当前业务决定。
- `intermediate/ops.json`、`pending_mapping.json`：尚待提交的一批 patch 及预期片段映射。
- `intermediate/project.json`：CLI 最近一次完整读回的原生工程。`submitted_mapping.json` 只在该工程与 pending mapping 校验通过后保存。
- 根目录：`<作业名>_<倍速>x.mp4`；后续增加字幕另存 `<作业名>_<倍速>x_字幕.mp4`，不覆盖已交付无字幕版。

原始 ASR 时间为毫秒。sentences 的 start/end、words 的 start/end 是对应原始素材的秒数；完整音频转写，因此不添加预切偏移。FableCut `in` 是源秒，`start/duration` 是成片秒：`duration = (end-start)/speed`。不能二次除倍速或把跨文件累计时间写入 `in`。

## 准备与转写

先运行：

```bash
python3 "$SKILL_DIR/scripts/probe_video.py" "/绝对路径/素材.mp4" --out "$RUN_DIR/intermediate/s1/video_info.json"
```

再读取并执行 tik-audio-asr 的音频提取步骤，输出该素材工作目录中的临时 MP3。转写前复核：

```bash
python3 "$SKILL_DIR/scripts/probe_video.py" "/绝对路径/素材.mp4" --audio "$RUN_DIR/intermediate/s1/audio.mp3" --out "$RUN_DIR/intermediate/s1/audio_info.json"
```

只有复核通过才调用 tik-audio-asr 的 `scripts/transcribe.py transcribe <音频绝对路径>`，将成功标准输出的唯一 JSON 对象原样保存到该素材的 audio.json。不要通过模型逐项重建 JSON；不得输出 API Key 或上传地址。缺凭据、空结果、时间轴检查失败时停止相关流程，报告原因。

音频/视频原点差超过 0.1 秒或提取后时长差超过 0.5 秒会失败，避免将不可靠时间戳当成剪点。断流等非均匀漂移不能靠加常数解决；需检查源片和提取音频，不允许用伪造 ASR 时间戳补偿。探查通过仍须抽查实际音画同步。

## sources.json

```json
{
  "sources": [
    {
      "id": "s1",
      "path": "/绝对路径/源视频.mp4",
      "probe": "/绝对路径/run/intermediate/s1/video_info.json",
      "transcript": "/绝对路径/run/intermediate/s1/audio.json",
      "range": [30, 180],
      "media_id": "从import-media返回的真实ID"
    }
  ]
}
```

`range` 仅用户指定时填写，单位原始素材秒；未指定则整段可选。`media_id` 在导入成功后添加，不是转写阶段的必需字段。`probe` 指向 probe_video.py 生成的真实探查文件；CLI 导入结果可能只含 id/kind/src，缺少 duration 时脚本以此探查文件校验源边界，不猜测或重注册素材。音频完整转写，只允许选择完全落入 range 的短语；边界处没有可靠词时间戳则不截出半句。范围本身无完整可用内容时说明限制，不扩张用户范围。

```bash
python3 "$SKILL_DIR/scripts/build_sentences.py" --sources "$RUN_DIR/intermediate/sources.json" --out "$RUN_DIR/intermediate"
```

已有 sentences.json 时脚本拒绝重建。说话人保留范围和内容方向变化时继续使用原编号；换素材或重新转写须新建 run。

句子记录包含 `index, source_id, raw_sentence_index, start, end, text, speaker, speaker_id, eligible, words`。speaker_id 如 `s1:0`，同一 channel_id 在另一个文件中是另一个声音身份。eligible 标注源范围资格，不删除全量编号。words 来自原始 ASR，缺失/定位不可靠时不伪造。

## 业务决定

```json
{"template": "内容策略", "keep_indices": [15, 16, 41, 48, 49, 52, 93, 94]}
```

edit_config.json 示例（示例数字仅说明接口，不构成已替用户作出的选择）：

```json
{
  "namespace": "cut_20260908_181200",
  "speed": 1.1,
  "target_duration": 75,
  "allowed_speakers": ["s1:0"],
  "groups": {"hook": [15, 16], "value": [41, 48, 49, 52], "close": [93, 94]},
  "subtitles": false,
  "transition": {"type": "none"},
  "project": {"width": 1080, "height": 1920, "fps": 30}
}
```

- namespace 使用本轮唯一的小写标识，修改同一 run 时不变；它决定本轮片段 ID 的命名空间。
- 三模块拼接必须与 keep_indices 完全同序且无重复。配置来自本轮用户/档案决定；保留全部说话人时显式列出所有 speaker_id。
- 用户要求转场才设置 `transition.type`，类型来自 tik-edit-video；duration 默认 0.3 秒。转场让后一片段提前并写 transitionIn。过短片段无法容纳转场时报告错误，不静默改参数；fade 会叠化音频，须试听对白重叠。
- 用户要求句内精调才添加 `refinements`，如 `{"41": [[123.1, 125.8], [126.3, 127.4]]}`。这些保留区间必须取自句子真实词级边界且有序、不重叠；句内去掉一段会产生多个片段，仍对应同一个句子编号。默认不添加尾音 padding；切尾有问题时须检查源音频而非猜时间。
- `subtitle_text` 用 `"句号索引:分段序号"` 为键，例如 `{"41:0": "苎麻面料"}`；分段序号从 0 起，仅更正对应字幕文本。精调导致分段改变时重新核对这些键。`subtitle_style` 可提供 tik-edit-video 文本属性以满足用户样式要求；不在其中写 text。
- 分组、字幕文字、精调等为决策数据，不塞进原生工程的自定义顶层字段。工程 mapping 保存 index→clip ID/源素材/文本/预期几何关系。
