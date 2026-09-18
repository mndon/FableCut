# 工程交接模式

当收到配套任务文件与 tik-editvideo-cli 工程，或任务明确要求复用已准备素材/转写并回传工程时使用。依据任务内容和实际文件识别，不依赖调用方名称。普通原始素材任务继续按 SKILL.md 原流程。

有 request.json 时按下文核验输入指纹并生成 result.json。若只提供工程和自然语言要求，先核对 media.src、media.asrUrl 与素材准备依据；信息缺失时询问缺项，不自行认定已完成准备。不编造 request、run_id 或指纹；复用已核实的素材与转写完成剪辑后交付可下载 project.json，只有对方要求协议回执时才补齐任务文件。下文涉及 request、哈希和回执的步骤仅适用于配套任务文件齐全的情况。

## 接收已准备素材

1. 挂载输入默认位于 `/mnt/session/uploads/tik-slicer/input/`；以当轮消息提供的真实路径为准。request.protocol 必须为 `tik-video-semantic-slicer-connector/v1`。核对 project.json 的规范 JSON SHA-256 等于 request.project_sha256（算法见下方）；不匹配就停止。
2. 保存不可变输入副本和 run_id。project 是 tik-editvideo-cli 原生时间线，不是 Managed Agent 的 IaC project 配置。request.requirements 是用户需求；sources 按稳定 source ID 对应 media_id，可含准备后源秒范围。
3. 按 media.src 下载/读取实际素材，逐个核对二进制 SHA-256 与 request.sources[].sha256。已有挂载文件不需要下载。本地使用独立工作目录，不能改挂载原件。素材不可达/不匹配就报告，不下载另一份原视频凑合。
4. 客户端已做归一化与 ASR，**不再归一化、转码、裁头、补静音或重新转写**。读取已安装 slicer 的准备契约，用 `probe_video.py` 只读探查；素材时间不满足契约则返回客户端处理。复用 media.asrUrl 下载原始 rich_result/channel JSON；失败/空结果报告，不检查 ASR 凭据、不重转。
5. 用这些云端本地路径创建 sources.json，保留 request 中的 source ID、range、media_id、asr_url；probe/transcript 指向实际云端文件。首次构建完整稳定索引，续接原会话沿用原索引与内容标注。新的 run_id 不意味着必须重建相同素材的索引。

## 语义剪辑

执行 slicer 的商品划分、完整语义组、内容策略、红线、钩子和审核步骤。用户已确认的要求不重复询问；未定商品、声音或钩子就将摘要/选项返回客户端，等待用户答复。不能为了无人交互静默选第一款或把助播当主播。

仍通过 tik-edit-video 的 CLI 建云端独立工作工程、导入实际下载素材、生成 patch、读回并执行 verify_output。导入会生成云端 media ID，保存显式映射 `输入 media_id ↔ 云端 media_id`；sources 和 submitted_mapping 使用实际云端 ID。云端工作工程不能被客户端 revision 覆盖。

继续保留 sources、sentences、content、selection、config、review、submitted_mapping；它们是下一轮修改的必要上下文。没有视听能力则标为 pending，不把结构验证当作试听。此次交接模式默认不启动供客户端使用的云端预览、不导出 MP4。

## 输出可移交工程

1. 对读回验证通过的云端工程复制一份输出 project.json，**只在输出副本**将 media.id、clips.mediaId 从云端 ID 映射回输入 media ID；素材 kind/duration/asrUrl 恢复输入绑定。工作工程和 submitted_mapping 保留云端 ID，避免破坏续接修改。
2. 所有输入素材 ID 均保留；不得在切片过程中引入未授权的音乐、图片或新媒体。保留输入画幅/FPS及用户要求；确保片段基于同一源时间。云端 src 可以保留工作副本地址，客户端会按 ID 恢复本地素材 src。
3. 映射后的输出再检查 mediaId 引用、片段边界、35–90 秒时长、ASR 绑定。不得只把客户端旧 project 原样输出并宣称剪辑完成。
4. 在独立输出目录写 result.json，示例标准库代码（路径改为本轮真实路径，视听状态必须符合实际）：

   ```python
   import hashlib, json
   from pathlib import Path

   def sha(value):
       raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                        separators=(",", ":"), allow_nan=False).encode("utf-8")
       return hashlib.sha256(raw).hexdigest()

   request = json.loads(Path("/mnt/session/uploads/tik-slicer/input/request.json").read_text())
   project = json.loads(Path("/mnt/session/outputs/project.json").read_text())
   result = {
       "protocol": "tik-video-semantic-slicer-connector/v1",
       "run_id": request["run_id"], "status": "completed",
       "input_project_sha256": request["project_sha256"],
       "project_sha256": sha(project),
       "verification": {"geometry": "passed", "audiovisual": "pending"}
   }
   with Path("/mnt/session/outputs/result.json").open("x") as output:
       json.dump(result, output, ensure_ascii=False, indent=2, allow_nan=False)
   ```

5. 使用当前运行环境支持的附件交付能力，交付 **可下载**的 project.json 和 result.json，附本轮 run_id 与简短结果/待验说明。服务器本地路径、消息中的 JSON 片段、localhost 预览链接都不能替代实际可下载文件。若环境无法提供附件或已授权存储，明确报告传输阻塞，不声称客户端已同步。

客户端负责恢复本地绑定、处理并发修改、提交并展示本地预览。服务器不得发送要求客户端 --force 覆盖工程的指令。
