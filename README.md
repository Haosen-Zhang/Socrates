# Socrates / 苏格拉底

Socrates 是一个多模型群聊式 Agent 工作台。它允许用户把不同厂商的大模型邀请到同一个任务房间中，为它们分配角色、控制发言顺序和讨论轮数，并指定最终模型进行总结或执行。

它的核心不是“在多个模型之间切换”，而是让多个模型围绕同一个问题进行结构化讨论：提出方案、审查反驳、补充细节、形成决策，最后进入可控执行。

## 当前阶段

本仓库当前只包含产品和工程设计文档，暂不包含应用代码。

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
