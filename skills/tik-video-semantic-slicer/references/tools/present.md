# 脚本展示

模型先读 speakers_summary.json，再通过一次全量索引读取理解素材。范围外标记不能作为可选内容，声音标签不能当成真实人物识别。

```bash
python3 "$SKILL_DIR/scripts/render_selection.py" --index --sentences "$RUN_DIR/intermediate/sentences.json"
```

候选钩子只展示钩子，不提前定价值/收束。2–3 个候选分别调用；已知倍速才传 `--speed`，否则成片时间列显示「待定」。

```bash
python3 "$SKILL_DIR/scripts/render_selection.py" --sentences "$RUN_DIR/intermediate/sentences.json" --hook 15,16 --label "候选1（推荐）"
```

完整方案草稿传本轮配置与选择：

```bash
python3 "$SKILL_DIR/scripts/render_selection.py" --sentences "$RUN_DIR/intermediate/sentences.json" --selection "$RUN_DIR/intermediate/keep_selection.json" --config "$RUN_DIR/intermediate/edit_config.json"
```

出片后完整脚本必须额外传最新读回的 `--project <project.json>` 和已核对的 `--mapping <submitted_mapping.json>`；显示实际 clip 的源区间和成片时间，不能仅用旧 ASR 时长累加。映射/工程不同步则先协调并重新验证，不展示失真的成片脚本。

输出按 modules.json 配置的钩子、价值、收束顺序排列，列固定为编号 / 源时间 / 秒 / 成片时间 / 文本。源时间附带素材 ID，保留毫秒精度；句内裁成多段时同一编号可以多行显示。字幕术语更正不改原声脚本，交付时另说明更正。

凡展示脚本或句子均原样贴出本工具输出；每轮修改后完整重渲染。内容维度归纳由切片师按业务策略用纯文本展示，说话人清单来自摘要，两者不伪装成脚本原句。
