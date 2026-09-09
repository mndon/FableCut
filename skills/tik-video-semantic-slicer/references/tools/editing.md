# FableCut 剪辑与验证

先完整读取 tik-edit-video 的 SKILL.md，按任务读其项目结构、时间语义、文本与转场参考。这里只描述语义选句如何接到该技能；不实现传输或渲染。

## 工程与素材

无指定工程时创建本轮专用工程，名称用作业名；记录真实返回 ID。用户指定工程则先读取紧凑时间线，确认作用范围。已有其他内容占据 V1（字幕开启时也包括 V2）时，不把新切片覆盖上去；新建独立切片项目或与用户明确处理方式。

```bash
tik-editvideo-cli create-project --name "服装语义切片"
```

每个原始文件使用 `import-media --project <真实ID> --path <绝对路径>`，把返回 media.id 填入 sources.json。素材 ID 与远端 media.src 均以 CLI 返回的信息为准。

生成操作前运行 `get-project --project <真实ID>` 保存完整原生项目文档为 project.json，记录实际 revision。紧凑摘要只供快速检查，不能代替完整项目作为脚本输入。

## 生成与提交

```bash
python3 "$SKILL_DIR/scripts/build_edit_ops.py" --sentences "$RUN_DIR/intermediate/sentences.json" --selection "$RUN_DIR/intermediate/keep_selection.json" --config "$RUN_DIR/intermediate/edit_config.json" --sources "$RUN_DIR/intermediate/sources.json" --project "$RUN_DIR/intermediate/project.json" --project-id "$PROJECT_ID" --out "$RUN_DIR/intermediate"
```

修改已提交作品时额外传 `--previous "$RUN_DIR/intermediate/submitted_mapping.json"`。上轮 mapping 只在上轮提交读回验证通过后存在，不能用本轮 pending 文件冒充。生成器会检查上一轮工程几何是否仍匹配，并只删除/更新该 mapping 管理的片段；不删除素材或无关片段。

脚本先验证选择、分组、说话人范围和时长，再生成 ops.json / pending_mapping.json；它不联系服务、不执行 CLI、不生成成片。目标偏差超过 5 秒会提醒，切片师应对照用户期望调整；35–90 秒以变速和转场后的实际总长校验。

将 ops.json 的内容作为单个字符串实参交给 CLI。下面是安全的文件读入方式：引用路径变量，命令替换只读取文件，JSON 内容不会作为 shell 代码再次解释。

```bash
tik-editvideo-cli patch-project --project "$PROJECT_ID" --ops "$(cat "$RUN_DIR/intermediate/ops.json")"
```

此命令单独执行并检查退出码；失败立即停止，不能接着导出、重新创建工程或执行替代接口。单次参数超过操作系统限制时停止并说明，先缩小本批操作后重新读工程规划；不临时实现一个替代客户端。

成功后再次 `get-project` 保存最新完整 project.json，并运行：

```bash
python3 "$SKILL_DIR/scripts/verify_output.py" --project "$RUN_DIR/intermediate/project.json" --mapping "$RUN_DIR/intermediate/pending_mapping.json"
```

通过后把 pending_mapping.json 内容保存为 submitted_mapping.json；本地快照、映射和业务配置共同用于下一轮修改，但远端实际工程仍是已提交时间线的依据。revision 冲突由 CLI 处理；读回内容不符时说明差异，不用 set-project --force 覆盖。

## 字幕与句内调整

字幕开启时通过 FableCut 生成 V2 文本片段。默认 Noto Sans SC、白字、底部深色背景、静态显示、文本框自动适配；预览确认中文字体已加载且无缺字，按用户样式要求调整 subtitle_style。字幕随片段变速、移位、句内拆分更新，转场重叠时在下一片段开始处切换字幕，避免同位置叠字。

默认通过选句去废话。用户明确指定句内精调时，局部读取指定句 words，用真实边界写入 refinements；缺词级信息则说明无法可靠精调，不插值。重新生成 patch 会同时重排后续片段、字幕和 mapping。精调前展示拟保留的词段和时间；已授权的调整不额外重复问许可。

变速、转场、字幕和片段更新都重新生成操作、提交、读回验证，再用工程映射展示完整脚本。用户手动改过管理片段时先协调具体差异，不能从旧 mapping 静默覆盖手工修改。

## 导出与交付

按 tik-edit-video 检查 Chrome/Chromium 等导出依赖，使用其 `export` 命令：

```bash
tik-editvideo-cli export --project "$PROJECT_ID" --output "$RUN_DIR/服装语义切片_1.1x.mp4"
```

示例输出名须替换为实际作业名/倍速。成片由 CLI 导出，CLI 出错停止。导出后再次读工程并确认与提交映射一致，避免把并发变化后的文件当成已验证作品：

```bash
python3 "$SKILL_DIR/scripts/verify_output.py" --project "$RUN_DIR/intermediate/project.json" --mapping "$RUN_DIR/intermediate/submitted_mapping.json" --video "$RUN_DIR/服装语义切片_1.1x.mp4"
```

校验内容：片段 ID/顺序对应的几何、倍速、字幕属性、素材边界、有效轨道、35–90秒工程总长、导出时长差≤1秒、画幅、H.264及音视频流；音视频流时长差>0.2秒拒绝。不额外限制 H.264 的 profile/level。工程有截取 in/out 点时必须先明确，否则不能保证导出的是完整切片。

检查 FPS、响度、字幕安全区和切点听感；程序不判断业务语义或口型同步。预览链接为实际 `FABLECUT_URL` 加 `/?project=<真实ID>`，未配置服务地址时使用 CLI 文档的默认 `http://127.0.0.1:7777`。Token 不放进链接；本地地址不能宣称为外网可分享链接。

最终展示：可点击的 MP4 路径、项目预览链接、工程快照路径、render_selection 从工程渲染的完整脚本，以及按编号修改的简短引导。
