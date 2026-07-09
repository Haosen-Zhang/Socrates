# ADR-0002: 编排引擎运行在 Bun sidecar，前端经 HTTP + SSE 通信

- **状态**：已接受（2026-07-09）

## 背景

Tauri 主进程是 Rust，不是 Node——TS 编排引擎（含 Vercel AI SDK）必须另择 JS 运行时。候选：WebView 前端内跑（零 IPC 但关窗即断，锁死单窗口形态）、Node sidecar（单文件打包需 SEA/pkg，TS 需编译步骤）、Bun sidecar。

## 决定

- 编排引擎 + AI SDK 跑在 **Bun sidecar** 独立进程，`bun build --compile` 出单二进制作为 Tauri sidecar 分发
- 通信：sidecar 跑 **Hono**，绑定 127.0.0.1 随机端口 + 随机 token，启动时经 stdout 握手交给 Tauri 转发前端；命令走 POST，流式走 **SSE**
- **API Key 全权在 sidecar 侧**：`@napi-rs/keyring` 读写系统 Keychain，key 不经过前端与 IPC，SQLite 只存 `apiKeyRef`（`docs/03` §5.1）
- 存储用 **bun:sqlite**（内置，免原生模块编译）
- 测试用 **bun test**（内置，Jest 兼容 API）

## 后果

- 讨论可后台持续，为 V2 多窗口/后台任务铺路
- 代价：比 WebView 内跑多一层进程管理与握手；MVP 交付稍慢
- 风险：Bun 生态较 Node 年轻，个别 npm 包可能有兼容问题——遇到时逐包评估替代
