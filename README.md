# Socrates / 苏格拉底

Socrates 是一个多模型群聊式 Agent 工作台。它允许用户把不同厂商的大模型邀请到同一个任务房间中，为它们分配角色、控制发言顺序和讨论轮数，并指定最终模型进行总结或执行。

它的核心不是“在多个模型之间切换”，而是让多个模型围绕同一个问题进行结构化讨论：提出方案、审查反驳、补充细节、形成决策，最后进入可控执行。

## 当前阶段

MVP 开发中。产品与工程设计见 `docs/`，实现按 GitHub Issues 的票逐张推进（spec 见 issue #2）。

## 开发

依赖：[Bun](https://bun.sh)、[Rust](https://rustup.rs)（Tauri 需要）。

```bash
bun install
bun run dev        # 启动桌面应用（Tauri + sidecar）
bun test           # 运行测试
bun run typecheck  # TypeScript 类型检查
```

代码结构（Bun workspaces）：

| 包 | 内容 |
| --- | --- |
| `apps/desktop` | Tauri + React 桌面应用 |
| `apps/sidecar` | Bun sidecar：编排引擎宿主，HTTP + SSE 服务 |
| `packages/core` | 纯 TypeScript 编排逻辑与领域类型（零 IO 依赖） |

## 文档目录

| 文件 | 内容 |
| --- | --- |
| `docs/01-product-requirements.md` | 产品定位、用户场景、功能需求、非功能需求、MVP 范围 |
| `docs/02-system-architecture.md` | 总体系统架构、核心模块、数据流、技术栈建议 |
| `docs/03-engineering-design.md` | 领域模型、存储设计、服务边界、测试和工程实践 |
| `docs/04-orchestration-protocol.md` | 多模型群聊编排协议、发言策略、黑板机制、执行契约 |
| `docs/05-security-permissions.md` | API Key、权限、工具执行、安全边界、审计日志 |
| `docs/06-mvp-roadmap.md` | MVP 迭代路线、阶段目标、验收标准、主要风险 |

## 一句话定位

Socrates turns multiple AI models into a structured council that can debate, review, decide, and execute together.
