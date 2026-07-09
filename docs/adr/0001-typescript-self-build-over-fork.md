# ADR-0001: TypeScript 单栈自建，不 fork 现有开源项目

- **状态**：已接受（2026-07-09）
- **依据**：`docs/research/2026-07-08-open-source-agent-base.md`（20+ 候选一手调研）

## 背景

Socrates 需要「多模型群聊 UI + 可控轮次编排」。期望基于开源项目改造以加速，调研后发现：没有任何开源项目同时具备这两点；带 UI 的头部项目（LobeHub、Open WebUI、Dify、Cherry Studio）的 license 均阻断商用 fork；编排框架（AutoGen 进入 maintenance mode、AG2 处于 v1.0 换血期）无 UI 且多为 Python。

## 决定

TypeScript 单栈自建：

- **Provider 层**：Vercel AI SDK（Apache-2.0），多厂商开箱即用
- **编排层**：按 `docs/04-orchestration-protocol.md` 自写确定性状态机（MVP 编排本质是薄循环）
- **UI**：自建，交互形态借鉴 Open WebUI Channels 与 big-AGI Beam；编排语义借鉴 AutoGen GroupChat 与 llm-council 三段协议
- **桌面壳**：Tauri（`docs/02` §3.1 已定）

## 后果

- 全链路 MIT/Apache 依赖，商用零 license 风险
- UI 是工作量大头，无现成可抄，需自建群聊房间形态
- 被淘汰方案与理由详见调研报告对照表
