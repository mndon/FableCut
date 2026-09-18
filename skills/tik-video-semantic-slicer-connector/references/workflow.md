# 切片执行流程

本页供执行时读取，不向用户照搬内部步骤。CONNECTOR_DIR 为本 skill 的绝对目录。客户端配合 [tik-audio-asr](../../tik-audio-asr/SKILL.md) 与 [tik-edit-video](../../tik-edit-video/SKILL.md)；语义分析和工程生成交给云端切片师。发任务时明确素材、转写已准备以及需回传的文件，不要求对方识别客户端技能名称。

## 1. 客户端准备

1. 建立独立 run 目录，记录用户原始要求。按 [素材准备](preparation.md) 执行 `prepare_video.py`，以 preparation.json 的 `path` 为后续唯一素材。已有 ASR/工程保持原绑定，需要归一化时停止并说明，不能给旧 ASR 换素材。
2. 按 [素材准备](preparation.md) 复核完整音频，交给 tik-audio-asr 转写或复用原 ASR URL/JSON。下载失败不重转，空 ASR 不发起选句。客户端不重建语义索引；首次全量索引由服务端创建并持久保留。
3. 将已知商品、声音范围、内容方向、时长、倍速、字幕和原视频时间范围写入 requirements.json。未知项保留未知；需要结合 ASR 才能提出的商品/钩子问题由服务端返回，客户端原样展示并收集回答，不替用户选择。
4. 用 `tik-editvideo-cli` 新建本轮专用准备工程，设置实际画幅/FPS，导入准备后的素材及其 `--asr-url`。已有工程可复用，但先确认目标和范围，不能把无关素材/片段整体发给服务端。保存完整 `get-project` 快照，不能使用 compact 输出代替。
5. 按 [工程交换契约](exchange.md) 准备 bindings.json：每个实际素材有固定 source ID、真实 media ID、准备后文件 SHA-256 和云端可访问地址。大视频通过已有或用户指定的对象存储提供；不把 localhost、电脑绝对路径或原视频地址冒充准备后素材地址。没有可用传输位置时保留本地准备成果，询问上传位置。

## 2. 导出与发起会话

```bash
python3 "$CONNECTOR_DIR/scripts/exchange.py" export \
  --project "$RUN_DIR/client-project.json" --project-id "$PROJECT_ID" \
  --bindings "$RUN_DIR/bindings.json" --requirements "$RUN_DIR/requirements.json" \
  --run-id "$RUN_ID" --out-dir "$RUN_DIR/outbound"
```

输出 project.json、request.json 和 **仅留客户端**的 client-state.json。按 [百炼会话操作](managed-agent.md) 上传前两个文件及服务端交接说明，等待文件 `available`，绑定真实 Agent/Environment 创建新会话并挂载后发送任务。记录 session ID、输入指纹和发送进度。用户给的案例会话用于识别目标和理解流程；除非明确要求续接该会话，否则不向案例会话发消息。

服务端交接说明使用 [managed-handoff.md](managed-handoff.md)。客户端不上传凭据、client-state.json 或整个本机作业目录。

## 3. 等待与往返问答

- 读取 SSE 或分页事件，保留原始 cursor/event ID 去重；每次等待有时间界限。掉线后从已保存位置继续读取，不重新发送任务。`idle` 仅表示当轮停止，可能是在问问题，不能当作已完成。
- 商品摘要、钩子和问题来自服务端；展示给用户，回答携带同一 run ID 发回原 session。已确认要求持续有效。
- 服务端报错、鉴权失效、工具审批或素材失效时报告实际阻塞；不自动放行工具审批、不归档/删除会话。素材 URL 更新保持字节内容/SHA-256不变。
- 完成时必须拿到可下载的 project.json 和 result.json，核对 run ID 与输入指纹。云端 `/mnt/session/outputs/...` 路径或 localhost 预览链接不是交付物；没有附件/file ID/可下载 URL 时要求原会话交付实际文件。

## 4. 回传、验证与展示

1. 下载到本轮独立 inbound 目录，保留云端原件。重新完整读取客户端目标工程到 current-project.json。
2. 生成待提交文档（脚本不修改实际工程）：

   ```bash
   python3 "$CONNECTOR_DIR/scripts/exchange.py" receive \
     --state "$RUN_DIR/outbound/client-state.json" --project-id "$PROJECT_ID" \
     --current "$RUN_DIR/current-project.json" \
     --project "$RUN_DIR/inbound/project.json" --result "$RUN_DIR/inbound/result.json" \
     --output "$RUN_DIR/localized-project.json"
   ```

3. 脚本检查任务/文件指纹、素材 ID、ASR 绑定、源边界和成片时长，恢复客户端原素材记录，并使用客户端 revision。客户端自派发以来有任何修改时拒绝覆盖；保留结果，明确具体差异，按用户选择另建结果工程或协调合并。不能修改 state 来绕过冲突。
4. 用原生 CLI 的 revision 检查提交。下面的命令替换只读 JSON，不执行 JSON 中的内容；若超出系统参数长度限制则停止，不拆开不具备原子性的覆盖操作：

   ```bash
   tik-editvideo-cli set-project --project "$PROJECT_ID" --document "$(cat "$RUN_DIR/localized-project.json")"
   ```

   单独检查退出码，不传 `--force`。成功后完整读回，与 localized-project.json 比较除 revision 外所有内容，确认 revision 恰好增加 1；差异未解决不能称同步成功。
5. `tik-editvideo-cli status --project "$PROJECT_ID"` 获取客户端实际 `projectUrl`。按可用能力检查画面、声音、切点；云端/客户端未做的视听检查标为待验。默认仅交付此预览 URL；用户本次明确要成片才使用 CLI 导出 MP4，继续沿用预览合成器。

后续修改复用同一 session 中的 ASR/索引/审核和映射。每次派发保存新的客户端基线与唯一 run ID；服务端须针对新 request 更新结果关联。会话过期时需恢复服务端中间产物，不能拿 project.json 当作完整语义修改上下文。
