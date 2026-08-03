# ADR-0003: MVP 不实现共享黑板，全量历史直传

- **状态**：已接受（2026-07-09）；全量历史无条件直传部分将在
  [ADR-0008](./0008-context-history-memory-authority.md) 的迁移门禁完成后被部分取代

## 背景

`docs/01` §8 的 MVP 范围未列黑板，`docs/04` §8 却写「MVP 可用简单解析」——两文档矛盾。业内主流多 agent 群聊实现（AutoGen/AG2 GroupChat、Microsoft Agent Framework GroupChatOrchestrator、llm-council）均为共享完整消息历史，无结构化黑板；黑板仅见于 MetaGPT 等软件流水线场景。

## 决定

- MVP：agent 之间共享**全量消息历史**（2-4 agent × ≤6 轮完全装得下）
- `docs/04` §5 输出契约的 Position/Critique/Proposal 小节保留为**纯 prompt 约定**，不做解析、不建快照存储、不做黑板 UI
- 黑板整体（解析、SQLite 快照、面板 UI）推迟到 V1，届时上下文长度才真正需要它

## 后果

- MVP 省掉解析器、`blackboard_snapshots` 表和面板 UI
- Debate 模式质量依赖模型自觉遵守输出契约；若讨论质量不达标，此决定是首个复议点

## 后续决定

ADR-0008 保留本 ADR 对 MVP 不实现共享黑板的历史决定，但为长会话增加
Socrates-owned History、可追溯 Memory、Charter 和 ContextAssembler。只有相应迁移票
完成后，运行时才从“全量历史无条件直传”切换到按模型窗口装配和可审计压缩；在此之前
本 ADR 的现有行为继续有效。
