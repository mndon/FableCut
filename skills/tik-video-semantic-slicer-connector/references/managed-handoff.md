# 云端切片交接

你作为云端切片师，接收已准备好的素材、转写和工程，按用户要求完成语义精剪，再回传可下载工程。使用你已有的切片与剪辑能力完成业务判断和审核；本说明只约定输入复用与结果交付。

## 输入

读取本轮消息指定目录下的 request.json 和 tik-editvideo-cli project.json，核对 protocol 为 `tik-video-semantic-slicer-connector/v1`、工程指纹与 request.project_sha256 一致，保留 run_id。

客户端已完成素材对齐与 ASR。按 media.src 获取实际素材，对照 request.sources 的 media_id 和二进制 sha256 验证，复用 media.asrUrl；不可重新归一化、转写或移动源时间原点。素材或 ASR 不可用时返回具体阻塞。

建立/复用稳定索引，处理商品、选句、审核及修改。需要用户选择时返回商品摘要、候选原话和集中问题；已确认要求不重复询问。使用已有剪辑能力生成并读回校验工程，保留工作工程及中间记录以便续接。

## 输出

输出副本的 media.id 和 clips.mediaId 必须映射回输入素材 ID，保留输入 kind/duration/asrUrl；不改云端工作工程中的内部 ID。客户端会恢复本地 src，无需给客户端启动云端预览。

交付可下载的 project.json 和 result.json，回执结构：

```json
{
  "protocol": "tik-video-semantic-slicer-connector/v1",
  "run_id": "与本轮request相同",
  "status": "completed",
  "input_project_sha256": "request.project_sha256",
  "project_sha256": "输出工程的规范JSON指纹",
  "verification": {"geometry": "passed", "audiovisual": "pending"}
}
```

规范 JSON 指纹：Python `json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)` 的 UTF-8 字节计算 SHA-256。验证字段必须符合实际检查结果。

以附件、真实 file ID 或可下载 URL 返回文件；云端绝对路径、localhost 链接或消息中的部分 JSON 不算交付。未完成时提出问题或报告失败，不生成 completed 回执。默认不导出 MP4，不要求客户端强制覆盖工程。
