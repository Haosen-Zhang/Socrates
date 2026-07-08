# Socrates 多模型编排协议

## 1. 设计目标

编排协议定义多个 Agent 如何在同一个 Room 中围绕任务进行结构化讨论。

协议要解决的问题：

- 谁先发言。
- 每个 Agent 看到什么上下文。
- 是否必须反驳或补充前文。
- 如何更新共享黑板。
- 什么时候停止讨论。
- 谁负责最终总结。
- 谁负责生成或执行操作。

## 2. 基础术语

- Task：用户提交的一次任务。
- Round：一轮讨论，可包含多个 Agent turn。
- Turn：一个 Agent 的一次发言。
- Speaker：当前发言 Agent。
- Chair：主持人逻辑，可以是系统策略，也可以是一个 Agent。
- Final Summarizer：最终总结 Agent。
- Final Executor：最终执行 Agent。
- Blackboard：结构化共享状态。

## 3. Turn 生命周期

一个 Turn 包含以下阶段：

1. Select Speaker：根据 policy 选择发言者。
2. Build Context：构建该 Agent 的输入上下文。
3. Compose Prompt：合成 system、room rules、task、blackboard、history。
4. Call Model：调用模型并流式返回。
5. Parse Output：解析自然语言和结构化字段。
6. Update Blackboard：将关键发现写入黑板。
7. Persist Trace：保存消息、token、错误和状态。
8. Evaluate Stop Conditions：判断是否停止或进入下一轮。

## 4. 上下文包结构

建议每个 Agent 收到的上下文使用统一结构。

```text
System:
  You are {agent_name}, role: {agent_role}.
  Follow room rules and orchestration instructions.

Room Rules:
  {room_rules}

Task:
  {user_task}

Your Assignment This Turn:
  {turn_instruction}

Shared Blackboard:
  {blackboard_summary}

Relevant Previous Turns:
  {selected_history}

Project Context:
  {files_or_context_summary}

Output Contract:
  {required_output_schema_or_sections}
```

## 5. 输出契约

为了让黑板可更新，Agent 输出应鼓励包含结构化部分。

建议格式：

```markdown
## Position
本轮核心观点。

## Evidence
依据、引用的前文或文件。

## Critique
对前文的质疑或风险。

## Proposal
建议方案。

## Blackboard Updates
- finding: ...
- risk: ...
- decision_candidate: ...
- action_item: ...
```

不同模式可以调整输出契约。

## 6. 编排模式

### 6.1 Round Robin

固定顺序轮流发言。

适用场景：

- 成本可控。
- 用户已经知道想让谁先说。
- 普通多模型咨询。

示例顺序：

```text
User -> Claude Reviewer -> GPT Architect -> DeepSeek Implementer -> Claude Reviewer -> GPT Final
```

停止条件：

- 达到最大轮数。
- 用户取消。
- 预算耗尽。
- Final Agent 输出 ready_to_finalize。

### 6.2 Debate

一个 Agent 提出方案，另一个 Agent 反驳，第三个 Agent 综合。

适用场景：

- 架构选择。
- 论文观点论证。
- 复杂 bug 根因分析。
- 高风险代码修改。

推荐角色：

- Proposer：提出初始方案。
- Skeptic：找漏洞和反例。
- Synthesizer：综合并修正。
- Judge：做最终裁决。

### 6.3 Review Board

多个专家从不同角度审查同一个方案。

适用场景：

- 安全审查。
- 代码 review。
- 论文审稿模拟。
- 产品方案评审。

推荐角色：

- Architect Reviewer。
- Implementation Reviewer。
- Security Reviewer。
- Performance Reviewer。
- User Experience Reviewer。
- Chair。

Review Board 可顺序执行，也可并发执行，然后由 Chair 汇总。

### 6.4 Pipeline

把任务拆成固定阶段。

示例：

```text
Draft -> Critique -> Revise -> Verify -> Finalize -> Execute
```

适用场景：

- 写作。
- 代码 patch。
- 实验计划。
- 报告生成。

## 7. Speaker Selection

MVP 使用确定性 speaker selection。

```ts
type SpeakerSelectionInput = {
  policy: OrchestrationPolicy;
  round: number;
  turnIndex: number;
  previousTurns: Turn[];
  blackboard: Blackboard;
};
```

Round Robin 规则：

```text
speaker = speakingOrder[turnIndex % speakingOrder.length]
```

Debate 规则：

```text
round 1: proposer
round 1: skeptic
round 1: synthesizer
round 2: skeptic
round 2: proposer
round 2: judge
```

未来可以引入动态主持人，让 Chair Agent 根据黑板状态决定下一个发言者。

## 8. Shared Blackboard 更新

每个 turn 完成后，Orchestrator 应从输出中提取黑板更新。

MVP 可用简单解析：

- 从 `Blackboard Updates` 小节解析列表。
- 失败时把整段摘要写入 findings。

V1 可用结构化 JSON 输出：

```json
{
  "findings": ["..."],
  "risks": ["..."],
  "proposalUpdates": ["..."],
  "decisionCandidates": ["..."],
  "actionItems": ["..."]
}
```

## 9. 停止条件

讨论停止条件包括：

- 达到最大轮数。
- 达到最大 turn 数。
- 达到预算上限。
- Final Summarizer 判断信息足够。
- 所有 Reviewer 没有新的阻塞问题。
- 用户手动停止。
- 连续错误超过阈值。

停止后进入 finalization 阶段。

## 10. Finalization 阶段

Final Summarizer 应输出：

- 最终结论。
- 关键分歧。
- 被采纳的建议。
- 未解决风险。
- 行动计划。
- 是否建议执行。

如果存在 Final Executor，则继续进入 execution planning。

## 11. Execution Planning

Final Executor 不应直接执行。

它应先输出执行计划。

执行计划建议格式：

```markdown
## Execution Plan
1. 需要修改的文件。
2. 每个文件的修改意图。
3. 需要运行的命令。
4. 预期风险。
5. 回滚策略。

## Proposed Patch
待展示的 diff 或 patch。

## Approval Required
说明需要用户确认的操作。
```

用户确认后，Tool Layer 才执行。

## 12. 预算策略

预算维度：

- 最大轮数。
- 最大 token。
- 最大费用。
- 最大 wall-clock 时间。

预算达到时的行为：

- Stop：直接停止并总结已有内容。
- Ask：询问用户是否继续。
- Degrade：切换到更便宜模型。
- Summarize：压缩上下文后继续。

## 13. 示例配置

```json
{
  "roomName": "Code Review Room",
  "mode": "debate",
  "maxRounds": 6,
  "speakingOrder": ["opus-reviewer", "gpt-architect", "deepseek-implementer"],
  "requireCritique": true,
  "requireCitationsToPreviousTurns": true,
  "finalSummaryAgentId": "opus-reviewer",
  "finalExecutorAgentId": "gpt-architect",
  "budget": {
    "maxUsd": 3.0,
    "onLimit": "ask"
  },
  "execution": {
    "allowPatchGeneration": true,
    "requireApprovalBeforeWrite": true,
    "allowTerminal": false
  }
}
```

## 14. 设计原则

- 每个 Agent 必须知道自己本轮职责。
- 模型输出不能直接成为事实，需要进入黑板并可被反驳。
- 最终执行必须与讨论阶段分离。
- 高成本模型应优先用于审查和裁决，低成本模型可用于草稿和实现细节。
- 用户应始终能看见谁说了什么、为什么采纳、为什么执行。
