# 展示

先读 speakers_summary，再读一次全量紧凑索引：

```bash
python3 "$SKILL_DIR/scripts/render_selection.py" --index --sentences "$RUN_DIR/intermediate/sentences.json"
```

索引仅供内部理解，不能整篇贴给用户。后续使用 selection_tools query 查指定编号上下文。声音标签不是人物身份；ratio 是原句数量占比。

钩子只展示钩子，不预定整片。每个候选单独调用；候选 config 此时只需已明确的 product_id、可选 allowed_speakers。倍速未定不传 --speed：

```bash
python3 "$SKILL_DIR/scripts/render_selection.py" --sentences "$RUN_DIR/intermediate/sentences.json" --content "$RUN_DIR/intermediate/content.json" --config "$RUN_DIR/intermediate/edit_config.json" --hook 209,210 --label "候选1（推荐）"
```

工具校验该商品与已限定声音，未定倍速显示“待定”。候选输出原样贴入用户可见正文，不让用户到工具日志寻找。内容维度和商品摘要可用简洁概括，不冒充原句。

完整草稿：

```bash
python3 "$SKILL_DIR/scripts/render_selection.py" --sentences "$RUN_DIR/intermediate/sentences.json" --selection "$RUN_DIR/intermediate/keep_selection.json" --config "$RUN_DIR/intermediate/edit_config.json" --content "$RUN_DIR/intermediate/content.json"
```

出片后再加 --project project.json --mapping submitted_mapping.json，均为最新完整读回/校验文件；工具验证配置与已提交内容指纹，时间从实际工程取值。修改后完整重渲染，不只贴 diff。

列为编号/源时间/秒/成片时间/文本；语义组可包含多行短语，精调可使同编号多行。字幕文字更正不改变原声脚本，另作说明。最终链接用可点击路径，不把工程快照说成包含独立配置/映射；本地预览地址不能称为外网分享地址。
