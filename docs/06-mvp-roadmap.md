# Socrates MVP 路线图

## 1. 路线图原则

Socrates 的核心假设是：多模型结构化讨论能在复杂任务上提供比单模型更高质量的结果。

因此 MVP 不应优先追求完整 coding agent 能力，而应优先验证多模型群聊、发言控制、讨论质量和最终总结。

路线图原则：

- 先验证讨论价值，再加入执行能力。
- 先做确定性编排，再做动态主持人。
- 先做本地历史，再做长期记忆。
- 先做审批式 patch，再做自动执行。
- 先支持少数 provider，再扩展到更多模型。

## 2. Phase 0: 文档和产品定义

目标：明确产品边界、核心架构和工程原则。

产出：

- 产品需求文档。
- 系统架构文档。
- 工程设计文档。
- 编排协议文档。
- 安全权限文档。
- MVP 路线图。

验收标准：

- 能解释 Socrates 和 OpenCode、Crush、Kilo Code 的差异。
- 能解释 MVP 做什么、不做什么。
- 能解释为什么讨论和执行必须分离。

## 3. Phase 1: 多模型群聊核心 MVP

目标：跑通无工具、无文件操作的多模型群聊。

功能：

- 添加 provider。
- 添加 API Key。
- 添加模型。
- 创建 Agent。
- 创建 Room。
- 邀请多个 Agent。
- 设置发言顺序。
- 设置讨论轮数。
- 设置最终总结者。
- 支持 Round Robin。
- 支持流式输出。
- 保存本地历史。

暂不做：

- 文件读取。
- patch 生成。
- 命令执行。
- 复杂黑板 UI。

验收标准：

- 用户可以创建一个 3 个模型的 Room。
- 用户可以设置 6 轮讨论。
- 每个模型按顺序看到前文并发言。
- 最终模型可以输出 summary 和 action plan。
- 任务历史可重新打开。

## 4. Phase 2: Debate 和 Blackboard

目标：让讨论不只是轮流回答，而是具备反驳、修正和沉淀机制。

功能：

- Debate 模式。
- Agent 本轮职责提示。
- Shared Blackboard 基础字段。
- 从输出中解析 findings、risks、proposals、decisions。
- Blackboard Panel。
- 任务 trace 回放。
- token 和费用估算。

验收标准：

- Proposer、Skeptic、Synthesizer 能按职责输出。
- 黑板能展示讨论中形成的问题、风险和决策。
- 最终总结能引用黑板内容。

## 5. Phase 3: 项目上下文只读能力

目标：从聊天工具升级为项目工作台，但仍保持只读安全边界。

功能：

- Room 绑定项目路径。
- 文件树。
- 文件搜索。
- 用户手动选择文件加入上下文。
- Git status 和 diff 只读展示。
- Context Inspector。
- `.socratesignore`。

验收标准：

- 用户可以让多个模型讨论指定文件。
- 系统能说明哪些文件片段会发送给哪些模型。
- Agent 可以基于文件内容做 code review。
- 系统不写文件、不运行命令。

## 6. Phase 4: Patch Proposal

目标：让最终执行者生成可审查的修改方案，但不自动应用。

功能：

- Final Executor 生成 execution plan。
- 生成 unified diff。
- Diff viewer。
- Reviewer Agent 可复核 patch。
- 用户可以复制 patch 或手动应用。

验收标准：

- 多模型讨论后能生成 patch proposal。
- patch 生成前有总结和风险说明。
- patch 能被另一个 Agent review。

## 7. Phase 5: Approval-based Execution

目标：加入受控执行能力。

功能：

- 应用 patch。
- 写文件审批。
- 运行测试命令审批。
- 命令超时和输出捕获。
- 执行结果反馈给群聊。
- 审计日志。

验收标准：

- 写文件前用户看到 diff。
- 运行命令前用户看到命令和工作目录。
- 执行结果被记录并反馈给 Agent。
- 用户可以中止任务。

## 8. Phase 6: 高级能力

目标：从 MVP 走向完整工作台。

候选功能：

- Review Board 并发审查。
- Pipeline 模式。
- MCP 工具。
- 本地向量索引。
- Agent 私有记忆。
- Room 模板市场。
- 成本优化策略。
- 动态主持人 Agent。
- 多设备同步。

## 9. 推荐首批默认模板

### Code Review Room

Agent：

- Architect。
- Skeptical Reviewer。
- Implementation Reviewer。
- Final Summarizer。

适用：审查代码和架构方案。

### Bug Triage Room

Agent：

- Reproducer。
- Root Cause Analyst。
- Fix Planner。
- Regression Tester。

适用：复杂 bug 排查。

### Paper Review Room

Agent：

- Method Reviewer。
- Writing Reviewer。
- Skeptical Reviewer。
- Summary Chair。

适用：科研论文审稿和修改。

### Experiment Planning Room

Agent：

- Hypothesis Builder。
- Experimental Designer。
- Statistics Reviewer。
- Implementation Planner。

适用：科研实验设计。

## 10. 主要风险

### 10.1 成本过高

多模型多轮讨论天然更贵。

缓解：预算上限、费用预估、便宜模型草稿、高价模型裁决。

### 10.2 讨论冗长但没有结论

模型可能重复附和。

缓解：强制职责、输出契约、黑板、停止条件、最终裁决者。

### 10.3 用户无法理解谁在干什么

多模型 UI 容易混乱。

缓解：清晰头像、角色、轮次、发言目的、黑板摘要。

### 10.4 自动执行风险

模型可能生成危险命令或错误 patch。

缓解：执行与讨论分离、权限、审批、审计、默认只读。

### 10.5 Provider 差异复杂

不同供应商 message、tool calling、streaming 差异明显。

缓解：Model Gateway、统一 schema、provider adapter 测试。

## 11. 建议第一版不做的事情

- 不做团队协作。
- 不做云端同步。
- 不做完整 IDE。
- 不做自动 commit 和 push。
- 不做插件市场。
- 不做长期记忆自动学习。
- 不做完全自主执行。

这些能力很有价值，但会分散 MVP 对核心假设的验证。
