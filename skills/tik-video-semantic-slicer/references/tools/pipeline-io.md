# 数据契约与本地工具

命令中的 SKILL_DIR、RUN_DIR 为绝对路径。Python 3 标准库即可运行数据脚本；媒体探查需 ffprobe，音频提取遵循 tik-audio-asr。不在临时 Python 中猜 JSON 形状或用字符串替换编辑数据。

## 文件与时间

run 根目录放 `<作业名>_<倍速>x.mp4`；字幕版另存 `<作业名>_<倍速>x_字幕.mp4`。其余在 intermediate/：

| 文件 | 内容 |
| --- | --- |
| sources.json | 原始素材、探查/ASR路径、ASR URL、可选范围、导入ID |
| s1/video_info.json、audio_info.json、audio.json | 每素材的探查与原始ASR；更多素材用s2等 |
| sentences.json、speakers_summary.json | 稳定全量短语与声音摘要 |
| content.json | 商品区间与语义组，模型标注，不改原ASR |
| keep_selection.json、edit_config.json、review.json | 当前选择、参数、绑定本轮的审核 |
| ops.json、pending_mapping.json | 待提交操作和映射 |
| project.json、submitted_mapping.json | CLI完整读回快照与已验证映射 |

ASR 为原始素材毫秒；sentences/words 为原始素材秒。FableCut in 为源秒，start/duration 为成片秒：duration = (end-start)/speed。不能再次除倍速、加预切偏移或跨文件累计源时间。

## 探查与转写

```bash
python3 "$SKILL_DIR/../tik-audio-asr/scripts/check_environment.py"
python3 "$SKILL_DIR/scripts/probe_video.py" "/绝对路径/素材.mp4" --out "$RUN_DIR/intermediate/s1/video_info.json"
```

按 ASR 技能提取完整临时 MP3 后复核：

```bash
python3 "$SKILL_DIR/scripts/probe_video.py" "/绝对路径/素材.mp4" --audio "$RUN_DIR/intermediate/s1/audio.mp3" --out "$RUN_DIR/intermediate/s1/audio_info.json"
```

原点差>0.1秒、时长差>0.5秒失败。非均匀漂移不得用常数补偿；检查素材和提取步骤，不伪造时间戳。复核成功才转写，明确要求 JSON URL：

```bash
python3 "$SKILL_DIR/../tik-audio-asr/scripts/transcribe.py" transcribe "$RUN_DIR/intermediate/s1/audio.mp3" --return-mode 1
```

将返回的 `json_url` 保存为该 source 的 `asr_url`，再下载原始内容到 `transcript` 指定的 audio.json；不要把 URL 包装对象当成转写正文：

```bash
python3 "$SKILL_DIR/../tik-audio-asr/scripts/download_result.py" "$ASR_URL" --output "$RUN_DIR/intermediate/s1/audio.json"
```

`ASR_URL` 使用真实返回地址。转写成功后清理临时音频；下载失败保留 URL 并报告，不重新转写。已有工程时，先从对应 `media.asrUrl` 取得地址并下载，跳过凭据检查、音频提取和转写；已有本地原始 JSON 则直接复用。

sources.json 的顶层为 sources 数组，每项例如：
```json
{
  "sources": [{
    "id": "s1",
    "path": "/绝对路径/源视频.mp4",
    "probe": "/绝对路径/run/intermediate/s1/video_info.json",
    "transcript": "/绝对路径/run/intermediate/s1/audio.json",
    "asr_url": "https://example.com/s1-asr.json"
  }]
}
```

用户指定范围才加 range: [起秒, 止秒]，只允许完整落入范围的短语。media_id 在导入后由工具写入，不先填示例ID；复用已有工程时使用其中真实素材 ID。新转写须记录 asr_url，旧作业未记录时仍可复用其本地结果。素材顺序决定跨文件 index 顺序。

```bash
python3 "$SKILL_DIR/scripts/build_sentences.py" --sources "$RUN_DIR/intermediate/sources.json" --out "$RUN_DIR/intermediate"
```

sentences.json 为 `{"sentences": [...]}`，每项含 index、source_id、raw_sentence_index、start/end、text、speaker/speaker_id、eligible、words。有可靠词时间才按标点拆短语，否则保留原句。--no-split 仅用户明确整句粒度时用。已有文件拒绝重建；筛声音只改 allowed_speakers，跨文件同名声音不合并。summary 的 ratio 是原句数量占比，不是发言时长占比。

## 商品与完整语义组

模型读索引后写 content.json（编号仅示范结构）：

```json
{
  "products": [
    {"id": "p1", "label": "黑色斜肩套装", "spans": [[0, 515]], "evidence": "#610区分黑色前款与白色当前款，结合换款画面"},
    {"id": "p2", "label": "白色拉链套装", "spans": [[516, 621]], "evidence": "#521换白色、#611限定只有白色"}
  ],
  "units": [[209, 210], [148], [156, 157], [200, 201, 202], [262, 264]]
}
```

spans 为首尾均包含的稳定 index，每段限一个 source，不得重叠；同款可列多段。未知归属不强行标注。units 只需覆盖候选/选中表达，每组编号升序、不与其他组重叠，限同源同款。组内可跳过废话，但连续语境由模型判断。原 ASR 不变，句子编号也不变。选择必须完整包含语义组，不能切半组或跨模块拆组。

## 选择与配置

keep_selection.json：
```json
{"template": "内容策略", "keep_indices": [209, 210, 148, 156, 157, 200, 201, 202, 262, 264]}
```

edit_config.json：
```json
{
  "namespace": "cut_20260909_202025",
  "product_id": "p1",
  "speed": 1.1,
  "target_duration": 60,
  "allowed_speakers": ["s1:0", "s1:1"],
  "groups": {"hook": [209, 210], "value": [148, 156, 157, 200, 201, 202], "close": [262, 264]},
  "subtitles": false,
  "transition": {"type": "none"},
  "project": {"width": 368, "height": 640, "fps": 30}
}
```

例子仅说明接口，不是完整时长方案或自动默认。product_id 与声音限定必须匹配所选钩子；合并三模块等于 keep_indices，顺序相同且不重复。namespace 在同一 run 修改时保持不变。

- 用户要求转场才设置 type，合法类型见 tik-edit-video，duration 默认0.3秒；转场有重叠，过短片段报错，不静默改值。
- 获授权精调才加 refinements，例如 `{"41": [[123.1,125.8],[126.3,127.4]]}`，使用该句真实词边界，有序且不重叠。不默认加尾音 padding，不恢复删掉的间隙。
- subtitle_text 以“index:分段序号”为键，如 `{"41:0":"苎麻面料"}`；subtitle_style 不含 text。精调改变分段后核对键，字幕更正不改原声。
- 语义组控制选择与审核；时间线仍保留短语/精调片段映射，不把被删除的停顿合并回来。相接区间不额外添加间隔。
- 业务字段不塞入原生工程。旧成片仍可核验；旧配置要修改/重新生成 patch 时补 product_id、content.json 与 review.json，不重建原句编号。

## 查询、试算与绑定

按编号查询上下文；--words 仅精调时增加词时间。输出供内部分析，用户脚本展示用 render_selection。

```bash
python3 "$SKILL_DIR/scripts/selection_tools.py" query --sentences "$RUN_DIR/intermediate/sentences.json" --indices 209,210 --context 2
python3 "$SKILL_DIR/scripts/selection_tools.py" estimate --sentences "$RUN_DIR/intermediate/sentences.json" --selection "$RUN_DIR/intermediate/keep_selection.json" --config "$RUN_DIR/intermediate/edit_config.json" --content "$RUN_DIR/intermediate/content.json"
```

estimate 不要求工程或 media_id，考虑倍速、转场和真实词级精调，返回各模块时长、总长、目标偏差与是否在35–90秒。结构错误会失败；时长不足可正常返回用于继续选句。

将 import-media 成功的完整 JSON 保存 import.json 后绑定：
```bash
python3 "$SKILL_DIR/scripts/selection_tools.py" bind-media --sources "$RUN_DIR/intermediate/sources.json" --source-id s1 --import-result "$RUN_DIR/intermediate/s1/import.json"
```

工具按 source_id 写入返回 media.id，不依赖字符串匹配；重复绑定同ID可重跑，不同ID报冲突。review-draft / check-review 见 [内容审核](editorial.md)。
