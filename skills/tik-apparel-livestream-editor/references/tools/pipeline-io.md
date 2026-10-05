# 数据契约与本地工具

命令中的 SKILL_DIR、RUN_DIR 为绝对路径。数据脚本仅需 Python 3 标准库；媒体准备由 CLI import-media 负责；转写及已有结果复用统一运行 `tik-video-editor-cli media --action asr --project-id <id> --media-id <id>`，自动绑定本地结果与 URL。不在临时 Python 中猜 JSON 形状或用字符串替换编辑数据。

## 文件与时间

默认交付工程预览 URL，不生成成片文件。用户明确要求导出时，run 根目录放 `<作业名>_<倍速>x.mp4`；字幕版另存 `<作业名>_<倍速>x_字幕.mp4`。作业数据在 intermediate/，实际媒体存放在 CLI 项目目录，run 仅保存准备结果和业务数据：

| 文件 | 内容 |
| --- | --- |
| sources.json | 实际素材、探查/ASR路径、ASR URL、可选范围、导入ID |
| s1/import.json、video_info.json | CLI 导入完整结果及 media 中的 duration/width/height；实际文件在项目目录 |
| s1/video_info.json、audio.json | 每素材的探查与原始ASR；更多素材用s2等 |
| sentences.json、speakers_summary.json | 稳定全量短语与声音摘要 |
| content.json | 商品区间与语义组，模型标注，不改原ASR |
| keep_selection.json、edit_config.json、review.json | 当前选择、参数、绑定本轮的审核 |
| ops.json、pending_mapping.json | 待提交操作和映射 |
| project.json、submitted_mapping.json | CLI完整读回快照与已验证映射 |

所有源时间均以 `source.path` 指向的实际转写与导入素材为准：ASR 用毫秒，sentences/words 和 tik-video-editor-cli in 用秒；start/duration 为成片秒，duration = (end-start)/speed。不能再加减归一化偏移、再次除倍速或跨文件累计源时间。

## 导入素材与获取转写

通过 tik-video-editor 创建或选择工程，再导入每个新素材；先导入再转写，输入文件校验、原点对齐和转码由 CLI 处理。符合要求的视频复制到项目目录，其他素材优先复制视频流，仅必要时重编码。原文件保留，失败停止，不执行替代预处理。

```bash
tik-video-editor-cli import-media --project-id "$PROJECT_ID" --path "$INPUT_VIDEO"
```

完整返回 JSON 保存 s1/import.json。读取 media.src 对应的本地文件路径 作为 source.path，media 中的 duration/width/height 保存 s1/video_info.json，记录返回 media.id。source.probe 是该 JSON 的绝对路径。先在 sources.json 写 id、原始 path 和 probe 输出路径，再使用下方 bind-media，可自动写入实际 path、original_path、探查 JSON 及 media_id。

已有本地 ASR 时加 --asr-local-path <本地JSON路径>，有 URL 时加 --asr-url；需要改变源时间原点则 CLI 拒绝，不能静默换源。已注册素材直接复用 ID 与实际路径，不重复导入；旧工程缺少准备记录时通过独立 CLI 工程、带 ASR 保护校验，不在 skill 内探查。

新转写使用导入后的实际视频：

```bash
tik-video-editor-cli media --action asr --project-id "$PROJECT_ID" --media-id "$MEDIA_ID" --output "$RUN_DIR/intermediate/s1/audio.json"
```

CLI 负责完整音频提取、复核和临时文件清理。无音轨素材可用于画面编辑，但 ASR 会报缺少语音。保存返回 json_url 为 source.asr_url，path 为 transcript。CLI 自动绑定 media.asrLocalPath/asrUrl；失败停止，不重复导入。

已有 URL 或转写成功但保存失败时，重新运行媒体命令恢复下载和本地绑定，不重新转写：

```bash
tik-video-editor-cli media --action asr --project-id "$PROJECT_ID" --media-id "$MEDIA_ID" --output "$RUN_DIR/intermediate/s1/audio.json"
```

媒体命令校验 ASR 格式，build_sentences 进一步校验 rich_result/channel；空转写停止选句。复用本任务当前环境已通过的 doctor/auth status，未登录按 tik-video-editor 流程处理，不搜索 shell 配置。

## 时长提示

目标及倍速确定后计算；不重新探查素材：

```bash
python3 "$SKILL_DIR/scripts/selection_tools.py" duration-ratio --sources "$RUN_DIR/intermediate/sources.json" --target-seconds 75 --speed 1.1
```

有效素材时长取导入后的探查值；用户指定范围则按范围累计，各文件源秒独立。R_fill=素材秒/(目标秒×倍速)，R_material=素材秒/目标秒。优先级与处理：

- insufficient（R_fill<1）：不能凑满目标，降低目标或补素材；未解决不出片，不靠加速凑时长。
- overlong（素材>7200秒）：仅说明转写与选句处理成本，供用户继续或先粗剪重传；不再单独提示 tight。
- tight（非不足、非超长且R_material<8）：提示去废话后可能不足，用户选择继续或补素材。
- 多项合并询问；没有触发不提示。目标/倍速变化后重算，目标未定时推迟到确定后、提交前。

## 素材记录与索引

sources.json 的顶层为 sources 数组；准备后先写素材字段，获得 ASR 后补 transcript/asr_url，再构建索引。完整记录例如：
```json
{
  "sources": [{
    "id": "s1",
    "path": "/绝对路径/CLI项目/media/素材.mp4",
    "original_path": "/绝对路径/源视频.mp4",
    "probe": "/绝对路径/run/intermediate/s1/video_info.json",
    "transcript": "/绝对路径/run/intermediate/s1/audio.json",
    "asr_url": "https://example.com/s1-asr.json"
  }]
}
```

source.path 始终使用 CLI 项目目录中的实际文件，original_path 仅用于追溯。用户指定范围才加 range: [起秒, 止秒]，以实际素材时间为准，只允许完整落入范围的短语；用户给的是原文件时间时先明确其时间原点再换算，不直接沿用。media_id 在导入后由工具写入，不先填示例ID；复用已有工程时使用其中真实素材 ID。新转写须记录 asr_url，旧作业未记录时仍可复用其本地结果。素材顺序决定跨文件 index 顺序。

```bash
python3 "$SKILL_DIR/scripts/build_sentences.py" --sources "$RUN_DIR/intermediate/sources.json" --out "$RUN_DIR/intermediate"
```

sentences.json 为 `{"sentences": [...]}`，每项含 index、source_id、raw_sentence_index、start/end、text、speaker/speaker_id、eligible、words。有可靠词时间才按标点拆短语，否则保留原句。--no-split 仅用户明确整句粒度时用。已有文件拒绝重建；筛声音只改 allowed_speakers，跨文件同名声音不合并。声音摘要沿用 `channel` 顺序，本地显示为“说话人1、说话人2……”；标签不代表真人身份，声音 ID 保持 `source_id:channel_id`。仅出现在词中的声音也保留在摘要中，原句数量为零。summary 的 ratio 是原句数量占比，不是发言时长占比。

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
  "host_speakers": ["s1:0"],
  "modules": [{"key":"hook","title":"钩子"},{"key":"value","title":"上身"},{"key":"close","title":"搭配"}],
  "groups": {"hook": [209, 210, 148], "value": [156, 157, 200, 201, 202], "close": [262, 264]},
  "subtitles": false,
  "transition": {"type": "none"},
  "project": {"width": 368, "height": 640, "fps": 30}
}
```

例子仅说明接口，不是完整时长方案或自动默认。product_id 与声音限定必须匹配所选钩子；modules 首项为 hook，key 唯一，groups 键与 modules 对应；按 modules 顺序拼接所有组须等于 keep_indices，顺序相同且不重复。新钩子2–5个完整语义组且只含 host_speakers；主体按叙事重排、组内源序。旧配置未含 modules 时保留旧三模块口径。namespace 在同一 run 修改时保持不变。

- 用户要求转场才设置 type，合法类型见 tik-video-editor，duration 默认0.3秒；转场有重叠，过短片段报错，不静默改值。
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

媒体转写统一使用 `media --action asr --project-id <id> --media-id <id>`。将导入返回的 `media.id` 保存为 `$MEDIA_ID`，工程 ID 保存为 `$PROJECT_ID`。命令优先复用有效 `media.asrLocalPath`，其次下载 `media.asrUrl`，无绑定才新转写；默认保存至工程 analysis/asr/，可用 --output 指定未占用路径。转写成功但下载失败时 URL 已保存，再次运行同一媒体命令继续下载，不重新转写。只有本地结果时 json_url 可缺省，不伪造 URL。新结果自动绑定，不再手动替换工程；跨设备本地路径不可用时按 URL 恢复。

实际文件路径解析：将 `media.src` 按路径段 URL 解码后拼接到 CLI 数据目录 `~/.tik-video-editor-cli/` 下。`import-media` 不返回 `preparation`；探查记录只保存 `media` 的 duration/width/height。
