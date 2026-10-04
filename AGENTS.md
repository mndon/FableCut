# FableCut 工作指南

完整的智能体手册见 [CLAUDE.md](CLAUDE.md)。在修改项目数据结构（schema）、使用 MCP 工具或编辑时间线之前，请先阅读该手册。本文件用于让遵循跨工具 `AGENTS.md` 约定的智能体（包括 OpenCode 和 Codex）找到同一份权威文档，避免重复维护。

## 项目约束

- 保持 FableCut 零运行时依赖，仅使用标准库。
- 保持预览与导出使用相同的合成器处理路径。
- 优先进行小而集中的修改，保留现有简洁的浏览器原生风格。
- 如果数据结构（schema）、属性（prop）、文字动画、API 或 MCP 接口发生变化，必须在同一次修改中更新 `CLAUDE.md` 和 `README.md`。
- 创建 PR 之前，运行 `node --check server.js && node --check app.js && node --check mcp-server.js`。

## MCP 入口

本地 MCP 服务器为 `mcp-server.js`，可以通过任何支持标准输入输出（stdio）的 MCP 客户端启动：

```bash
node /absolute/path/to/FableCut/mcp-server.js
```

请遵循 `CLAUDE.md` 中现有的操作示例和工具说明，不要另行设计一套协议或数据结构。

# 使用中文回答用户问题