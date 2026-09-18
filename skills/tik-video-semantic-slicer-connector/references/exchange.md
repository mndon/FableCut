# 工程交换契约 v1

工程永远是 tik-editvideo-cli 原生 JSON。请求/回执/state 是连接器旁路数据，不加入 media、clips 或项目顶层。脚本仅转换离线快照；不调用模型、ASR、tik-editvideo-cli 或百炼网络接口。

## 输入与导出

`client-project.json`：来自 CLI 完整读取；素材必须是本轮准备并绑定 ASR 的视频，具有 duration。推荐新建空时间线准备工程；复用既有切片时，输入 clips 仅包含本轮切片。图片、音乐或其他媒体请先明确范围，当前自动交换仅支持视频源，不隐式上传无关资源。

`bindings.json` 的 sources 顺序稳定，后续修改不得调换：

```json
{
  "sources": [{
    "id": "s1",
    "media_id": "m_actual_id_from_import",
    "remote_src": "https://your-storage.example/prepared.mp4",
    "sha256": "替换为准备后实际文件的64位小写SHA-256",
    "range": [0, 300]
  }]
}
```

- `media_id` 来自 import-media 返回值；按 ID 关联，不能按文件名、数组顺序或内容猜测。
- `remote_src` 为下载该文件的 HTTP(S) URL，或已挂载资源的真实 `/mnt/session/uploads/...` 路径。挂载时填写 `/uploads/...`；脚本中的 src 使用加 `/mnt/session` 前缀后的实际路径。
- URL 必须在云端能下载，且有效期覆盖作业；脚本仅做格式和明显本地地址检查，不保证网络可达。下载后计算 SHA-256 与请求核对，内容变化必须重做准备/ASR。
- ASR 使用原始项目 `media.asrUrl`，内容含 rich_result/channel，时间基于准备后的素材。旧作业只有本地 ASR JSON 时，先将原 JSON 放到用户授权的可访问位置并绑定真实 URL；不重新转写、不伪造 URL。
- range 可选，单位为准备后源素材秒，限制候选而非裁剪上传文件。SHA-256 对完整准备后文件计算。

`requirements.json` 为用户要求对象，例如：

```json
{
  "instruction": "灰色拉链款，突出上身效果，保留主播声音",
  "target_duration": 60,
  "speed": 1.1,
  "subtitles": false,
  "confirmed": ["灰色拉链款", "1.1倍速"],
  "unresolved": ["需要依据内容确认主播声音与钩子"]
}
```

示例不是自动默认。声音跨素材不合并；服务端索引显示声音标签后再确认真人归属。原始要求优先于连接器示例。

export 输出：

| 文件 | 保存位置/用途 |
| --- | --- |
| project.json | 发云端；仅替换 media.src 为可访问源，保留 media.id/asrUrl、clips、revision |
| request.json | 发云端；protocol、run_id、project_sha256、requirements、sources |
| client-state.json | 仅本地；client_project_id、基线原工程、基线指纹、request |

所有指纹均对解析后的 JSON 使用 Python `json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)` 编码为 UTF-8 后 SHA-256。不是文件原始字节 hash。视频文件 SHA-256 则对实际二进制字节计算。

## 返回

服务端输出原生 project.json 与 result.json；media.id 必须保持输入 ID，media.asrUrl/kind/duration 不变。服务端本地 src 可以不同，客户端按稳定 ID 恢复原素材记录。云端内部重导入产生的 ID 必须在输出工程 clips.mediaId 和 media.id 中一并映射回输入 ID，不能改输入 request。

```json
{
  "protocol": "tik-video-semantic-slicer-connector/v1",
  "run_id": "与请求相同",
  "status": "completed",
  "input_project_sha256": "request.project_sha256",
  "project_sha256": "返回工程的规范JSON指纹",
  "verification": {"geometry": "passed", "audiovisual": "pending"}
}
```

`verification` 是服务端检查记录，不是仅靠字段便能证明内容合格。客户端独立检查结构，并在本地预览检查视听。脚本不做语义判断；不支持速度关键帧的自动同步，遇到时报告需专门校验。

云端也可使用同一 `exchange.py seal-result --request ... --project ... --verification ... --output ...` 生成回执；若未安装连接器，使用服务端交接说明中的标准库示例。不能由客户端补造服务端完成回执来绕过关联校验。

## 并发与续接

- 同一个 run 的 input/request/state 不覆盖；重复导出目录或重复接收文件直接报错。
- receive 将新鲜读取的整个客户端 JSON 与派发基线比较，包含 revision 与媒体引用；任何变更均拒绝覆盖。随后 set-project 还会检查读取到提交之间的 revision 竞争。
- 服务端 revision 不是客户端 revision。不能把云端 revision 原样提交，也不能把最新客户端 revision 填进旧基线冒充无冲突。
- 没有 state 的旧案例产物不能自动覆盖任何本地工程。先显式建立新的导入工程和素材 ID 映射，核对绑定后按原生 CLI 导入；该迁移不是 receive 的正常路径。
- 每轮保留输入、云端结果、本地化候选和读回工程。服务器保留自己的 sources、索引、选择、审核、submitted mapping，下一轮继续使用；不在消息中反复粘贴大 JSON。
