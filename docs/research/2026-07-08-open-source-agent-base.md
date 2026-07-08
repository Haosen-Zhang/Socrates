# 开源基座调研：基于哪个开源项目改造 Socrates 最快

- **调研日期**：2026-07-08
- **研究问题**：GitHub 上有哪些开源项目可以作为 Socrates（多模型群聊式 Agent 工作台）的实现基础（fork 改造或深度借鉴）？基于哪个改造到 MVP 最快？
- **需求基准**：`docs/01-product-requirements.md`（MVP：OpenAI-compatible + Anthropic 双供应商、2-4 Agent、Round Robin / Debate、群聊流式 UI、本地历史，**不含**工具调用与文件写入）与 `docs/04-orchestration-protocol.md`（确定性 speaker selection、共享黑板、输出契约、finalization 与执行分离）。
- **方法**：只采信一手来源——GitHub 仓库（README、LICENSE 原文、源码目录、releases/tags、GitHub API 元数据）与项目官方网站。所有 stars / license / 活跃度数据为 2026-07-08 经 GitHub API 实测。

---

## TL;DR

1. **没有任何现成开源项目同时具备「多模型群聊 UI」和「可控轮次编排」**。专门做 multi-LLM debate/council 的项目全部是 <1k stars 的玩具或研究代码（含 karpathy/llm-council，作者明言不维护且无 license）。
2. **编排层是薄的，UI 才是工作量大头**。Socrates MVP 的编排是确定性循环（`speaker = order[turn % n]`），任何框架在 MVP 阶段只能省 1-2 周；但没有一个带 UI 的项目能直接给出「群聊房间」形态，且头部 UI 项目（Open WebUI / LobeHub / Dify）的自定义许可证均对商用 fork 不友好。
3. **推荐**：方案一（最快 MVP）= TypeScript 单栈自建，用 Vercel AI SDK（Apache-2.0）做 provider 层，编排协议按 04 文档直接实现，UI 交互借鉴 Open WebUI Channels 与 big-AGI Beam；方案二（最稳过渡到 V1/V2）= Microsoft Agent Framework（MIT）做 Python 编排后端 + 自建桌面前端，其 `GroupChatOrchestrator` 与 Socrates 协议逐条对应。

---

## 1. 评估维度

对每个候选考察：仓库地址、license、stars/活跃度、核心架构（群聊/编排如何实现、关键抽象）、多厂商模型支持、是否有前端 UI、与 Socrates 的差距、改造要动哪些层。Socrates 关键约束：

- 多厂商同房间（OpenAI/Anthropic/DeepSeek/Gemini/Qwen/Kimi/GLM/Ollama），Agent = 模型+角色+提示词+权限+预算；
- 用户可控的**确定性**编排（谁先说、几轮、谁总结、谁执行），而非 LLM 自主协作；
- 群聊式流式 UI（macOS 桌面优先、本地优先）；
- 共享黑板、执行审批、预算控制；
- **未来可能商用** → license 必须干净（MIT/Apache 优先，禁「衍生作品需授权」条款）。

---

## 2. Multi-agent 编排框架

### 2.1 Microsoft Agent Framework（MAF）— 编排层最佳匹配 ★

- **仓库**：<https://github.com/microsoft/agent-framework>
- **License**：MIT（GitHub API 检测，2026-07-08）
- **活跃度**：11,952 stars；最后 push 2026-07-08（当天）；最新 release `dotnet-1.13.0`（2026-07-03），Python 侧 tag `python-1.10.0`
- **背景**：AutoGen 与 Semantic Kernel 的官方合流后继者。autogen 仓库 README 顶部官方声明：*"AutoGen is now in maintenance mode… New users should start with Microsoft Agent Framework"*（[microsoft/autogen README](https://github.com/microsoft/autogen/blob/main/README.md)）。
- **核心架构**：Python + .NET 双栈；图式 workflow + 独立的 `orchestrations` 包。[`python/packages/orchestrations/agent_framework_orchestrations/`](https://github.com/microsoft/agent-framework/tree/main/python/packages/orchestrations/agent_framework_orchestrations) 内含 `_group_chat.py`、`_sequential.py`、`_concurrent.py`、`_handoff.py`、`_magentic.py`。其中 [`_group_chat.py`](https://github.com/microsoft/agent-framework/blob/main/python/packages/orchestrations/agent_framework_orchestrations/_group_chat.py) 的 `GroupChatOrchestrator`（源码 docstring 实测）：
  1. 接收初始消息并广播给所有 participants；
  2. 调用 `selection_func(state: GroupChatState) -> str` 选择下一个发言者（文档内置 round-robin 示例）；
  3. 请求被选中 participant 生成回复；
  4. 回复入 history 并广播给其他 participants；
  5. 循环直到 `max_rounds` / `termination_condition`。
  另有 `AgentBasedGroupChatOrchestrator`（LLM 主持人决定下一发言者，即 04 文档的「动态 Chair」）与 `GroupChatBuilder` 流式 API。**这与 Socrates 04 文档的 Turn 生命周期逐条对应**。
- **多厂商支持**：[`python/packages/`](https://github.com/microsoft/agent-framework/tree/main/python/packages) 目录实测含一方 provider 包：`anthropic`、`claude`、`gemini`、`openai`、`bedrock`、`mistral`、`ollama`、`foundry`、`foundry_local`；OpenAI-compatible 客户端可覆盖 DeepSeek/Qwen/Kimi/GLM。每个 participant 挂各自 chat client → 多厂商同房间原生成立。
- **UI**：无产品级 UI。[DevUI 的 README](https://github.com/microsoft/agent-framework/blob/main/python/packages/devui/README.md) 明言 *"DevUI is a sample app… not intended for production use"*。另有 `ag-ui`（AG-UI 协议）、`chatkit` 包可作前后端事件通道。
- **与 Socrates 的差距**：无群聊前端；无共享黑板（需扩展 `BaseGroupChatOrchestrator`，源码 docstring 明示该扩展点）；预算控制需自聚合 usage；企业/Azure 糖较多，本地桌面场景需剥离 hosting 相关。
- **改造要动哪些层**：直接用 orchestrations + provider 包 + workflow checkpointing；自写黑板扩展、预算 termination、Debate/ReviewBoard/Pipeline 的 selection_func 与输出契约解析；**自建整个桌面前端**；Python 运行时需打包进桌面 app（分发成本）。

### 2.2 AutoGen（microsoft/autogen）— 设计参考，不可作基座

- **仓库**：<https://github.com/microsoft/autogen>；59,580 stars；最后 push 2026-04-15
- **License**：代码 MIT（LICENSE-CODE），文档 CC-BY-4.0（README Legal Notices 明示）
- **状态**：README 顶部官方 CAUTION：**maintenance mode**，不再接收新功能，社区托管。
- **价值**：[`autogen-agentchat/teams/_group_chat/`](https://github.com/microsoft/autogen/tree/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat) 目录实测含 `_round_robin_group_chat.py`、`_selector_group_chat.py`、`_swarm_group_chat.py`、`_graph`（GraphFlow）、`_magentic_one`——是「群聊团队抽象」最成熟的公开实现，MIT 代码可自由搬运/借鉴。AutoGen Studio 是原型 GUI，README 明言 *"not meant to be a production-ready app"*。
- **结论**：**淘汰**（fork 无上游未来）；作为 RoundRobin/Selector/Termination 语义的**首选设计参考**。

### 2.3 AG2（ag2ai/ag2，autogen 社区分叉）— 时机不对

- **仓库**：<https://github.com/ag2ai/ag2>；4,747 stars；最后 push 2026-07-08；Apache-2.0（2024 年从 MIT 换轨，仓库保留 `license_original/`）
- **状态**：正处大重构换血期。README 顶部：*"AG2 is on the path to v1.0. The protocol-driven framework is now the top-level package… The classic framework (ConversableAgent, GroupChat, …) has been removed, and the import name `autogen` is no longer available"*。GitHub 最新 release `v1.0.0b0`（2026-07-03，beta）；PyPI 最新稳定版 `0.14.0`（经典架构线）。main 分支源码树实测已无 `agentchat` 目录（新结构为 `agent.py / assembly.py / policies / spec.py …`），与 README 示例代码不一致（过渡期文档滞后）。
- **经典 0.x 的 `GroupChat`/`GroupChatManager`（speaker selection: round_robin/auto/manual/custom）是 Socrates 语义的最经典实现**，但 fork 经典线 = 无上游未来，跟 v1 = 追移动目标。
- **结论**：**淘汰**（架构换血期，两头都不宜 fork）；经典 GroupChat 文档/源码作设计参考。

### 2.4 AgentScope（agentscope-ai/agentscope，阿里）— 第二梯队有力候选

- **仓库**：<https://github.com/agentscope-ai/agentscope>；27,574 stars；最后 push 2026-07-08；Apache-2.0；最新 release `v2.0.4`（2026-07-07）
- **状态**：2026-05 发布 2.0 大重写（README News 实测）。
- **核心架构（2.0）**：`src/agentscope/` 实测模块：`agent`、`event`（统一事件总线，`TEXT_BLOCK_DELTA` 等事件流为前端而生）、`permission`（细粒度工具/资源权限——直接映射 Socrates FR-009 审批）、`state`、`workspace`（本地/Docker/E2B 沙箱）、`model`、`middleware`、`app`。自带 FastAPI 多租户 agent service + `examples/web_ui` 预置 Web UI。
- **关键变化**：**2.0 删除了 1.x 的确定性多 Agent 会话原语**。1.x（[v1 分支 `pipeline/__init__.py`](https://github.com/agentscope-ai/agentscope/blob/v1/src/agentscope/pipeline/_msghub.py) 实测）有 `MsgHub`（广播消息中枢）、`SequentialPipeline`、`FanoutPipeline`；2.0 的 `src/agentscope/` 已无 pipeline 模块，转向「leader agent spawns workers」的自主 Agent Team 模式（README：*"leverages the models' reasoning… rather than constraining them with strict prompts and opinionated orchestrations"*——**哲学上与 Socrates 的用户可控编排相反**）。
- **多厂商支持**：`src/agentscope/model/` 实测：`_anthropic`、`_dashscope`（Qwen）、`_deepseek`、`_gemini`、`_moonshot`（Kimi）、`_ollama`、`_openai_chat`、`_openai_response`、`_xai`——**与 Socrates 首批目标供应商重合度所有候选中最高**（含中国厂商一方支持）。
- **与 Socrates 的差距**：群聊编排原语需自写（但该层本就薄）；`web_ui` 示例是单 agent 会话形态，群聊化改造量未知；2.0 发布仅 2 个月，API 未稳。
- **改造要动哪些层**：用 model/event/permission/state/workspace；自写 speaker-selection 循环 + 黑板 + 预算；前端重做或自建。

### 2.5 其余框架（一句话淘汰）

| 项目 | 数据（实测） | 淘汰理由 |
|---|---|---|
| [CrewAI](https://github.com/crewAIInc/crewAI) | 55,143★，MIT，release 1.15.2（2026-07-08） | Crew（自主协作）+ Flow（事件驱动流程）面向任务自动化交付，无「轮次辩论房间」原语，用户可控逐轮发言需逆框架而行 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 36,802★，MIT，release 1.2.8（2026-07-06） | README 自我定位 *"Low-level orchestration framework"*——只提供图运行时，群聊/黑板/轮次全部自写，省时有限；Studio/平台绑 LangSmith 商业生态 |
| [CAMEL](https://github.com/camel-ai/camel) | 17,343★，Apache-2.0，release v0.2.90（2026-03-22） | `camel/societies/` 实测仅两 Agent `RolePlaying` + `workforce` 层级分工，N-agent 用户可控圆桌不是其抽象；长期停留 0.x |
| [MetaGPT](https://github.com/FoundationAgents/MetaGPT) | 69,265★，MIT，最后 push 2026-01-21 | 固定「软件公司 SOP」流水线（README：*Code = SOP(Team)*），角色/流程写死；团队重心已转向商业产品 MGX（README News 停更于 2025-03） |
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | 27,732★，MIT，push 2026-07-08 | provider-agnostic（经 LiteLLM/any-llm 支持 100+ 模型，README 实测）但编排模型是 handoff/agents-as-tools（Agent 自主转交）≠ 外部策略轮流发言；无 UI |
| [Swarm](https://github.com/openai/swarm) | 21,772★，MIT | README 官方声明：*"Swarm is now replaced by the OpenAI Agents SDK"*，教学项目已冻结 |

---

## 3. 带 UI 的多模型聊天工作台

### 3.1 Open WebUI — UI 形态最接近，license 卡死商用 fork

- **仓库**：<https://github.com/open-webui/open-webui>；144,715 stars；release v0.10.2（2026-07-01）
- **License**：**Open WebUI License**（自定义，GitHub 检测 NOASSERTION）。[LICENSE 原文](https://github.com/open-webui/open-webui/blob/main/LICENSE)第 4 条实测：**严禁更改/移除 "Open WebUI" 品牌**，例外仅限 ①30 天滚动窗口内 ≤50 用户 ②书面许可 ③企业授权。→ 改名为 "Socrates" 的商用 fork 直接构成违约。
- **多模型群聊能力**（README 实测，所有 UI 候选中最接近）：
  - **Channels**：*"Real-time shared spaces where your team and AI models collaborate in one timeline. Tag models to draft or critique, with threads, reactions, pins, and access control."*——多模型同一时间线、@ 模型起草/评论，即「手动版群聊房间」；
  - **Multi-Model Conversations**：*"Engage several models at once… in parallel"*。
- **差距**：编排全靠用户手动 @，无轮次/策略/黑板/预算引擎；Python+Svelte 大型 web 代码库，Docker 服务器形态 ≠ 本地桌面；植入 Socrates 策略引擎 = 在陌生大库里造新子系统。
- **结论**：**淘汰作基座**（license + 架构形态）；**Channels 交互是 Socrates 群聊 UI 的最佳参考原型**。

### 3.2 LibreChat — provider 覆盖最广的 MIT 聊天 UI，但会话模型不匹配

- **仓库**：<https://github.com/danny-avila/LibreChat>；40,442 stars；MIT；最新 tag v0.8.7（push 2026-07-08）
- **多厂商**：README 实测覆盖 Anthropic/OpenAI/Azure/Google/Vertex/Bedrock + 任意 OpenAI-compatible 自定义端点（Ollama、DeepSeek、Qwen 等）——**provider 管理与 Key 管理这层是现成的，且 MIT**。
- **多模型同会话**：官方 changelog（[v0.7.4](https://www.librechat.ai/changelog/v0.7.4)、[config v1.1.7](https://www.librechat.ai/changelog/config_v1.1.7)）实测：*"Multi-response Streaming… generate 2 responses at once"*（又称 "multi convo"）——**并排对比 2 个回复的 scatter 模式，不是轮次群聊**。Agents 功能是单 Agent 助手（工具/MCP/子代理）。
- **差距**：会话模型 = 用户 ↔ 单端点（+对比分支）；群聊房间、轮次编排、黑板、多 Agent 角色体系全部要在 MERN 多用户服务器代码库内新造；面向多用户部署 ≠ 本地桌面。
- **结论**：**淘汰作基座**（编排层为零 + 架构形态错位，理解与改造大型既有代码库的成本高于自建）；其 provider 配置层（librechat.yaml 端点体系）可借鉴。

### 3.3 big-AGI — MIT 多模型工作台，Beam 基因最近但无轮次编排

- **仓库**：<https://github.com/enricoros/big-AGI>；7,038 stars；**MIT**；release v2.0.5（2026-05-13），push 2026-07-07
- **核心**：README 实测——multi-model AI workspace，20+ LLM 服务/500+ 模型（TS 自研 provider 层），**Beam & Merge**：同一提问并行发给 N 个模型 → 并排展示 → 融合成最终答案（*"multi-model de-hallucination"*，官方称 ~35% 用户日常使用）。local-first Next.js web app。
- **差距**：Beam 是每条消息的 scatter-gather，无角色/轮次/相互引用/黑板；无房间概念；单人主导项目（自研 AIX 框架，代码个人风格重，bus factor 低）。
- **结论**：**可借鉴不可 fork**——Beam 的多模型流式 UI 与 TS provider 层是「TS 自建路线」的最佳参考；MIT 无法律障碍。

### 3.4 其余 UI 项目（一句话淘汰）

| 项目 | 数据（实测） | 淘汰理由 |
|---|---|---|
| [LobeHub（原 lobe-chat）](https://github.com/lobehub/lobehub) | 79,606★，push 2026-07-08 | [LICENSE 原文](https://github.com/lobehub/lobehub/blob/main/LICENSE)：*"a commercial license must be obtained… if you want to develop and distribute a derivative work"*——**衍生作品需商业授权，fork 商用直接不可行**；且已转型 Agent Operator 平台 |
| [Dify](https://github.com/langgenius/dify) | 148,181★，release 1.15.0（2026-06-25） | 修改版 Apache-2.0：前端 LOGO 不可改、多租户需授权（LICENSE 实测）；本质是 workflow/LLMOps 平台而非群聊会话形态 |
| [Chatbot UI](https://github.com/mckaywrigley/chatbot-ui) | 33,285★，MIT | 最后 push 2024-08-03，已死库 |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | 48,312★，push 2026-07-08 | 桌面多厂商客户端但 **AGPL-3.0**（LICENSE 实测）——商用需整体开源衍生品；无群聊编排 |
| [Jan](https://github.com/janhq/jan) | 43,448★，Apache-2.0（LICENSE 实测） | 桌面本地优先聊天，但单模型会话形态，无任何多 Agent 概念，可省的只有桌面壳 |

---

## 4. 专门的 multi-LLM debate / roundtable / council 项目

用 `multi LLM debate`、`LLM roundtable`、`LLM council multi-model` 三组关键词经 GitHub Search API 扫描（2026-07-08），**该细分领域不存在成熟可 fork 的基座**——除下述外全部 <200 stars：

- **[karpathy/llm-council](https://github.com/karpathy/llm-council)**：22,379★，push 2025-11-22，**无 LICENSE 文件**（API 检测 license=none）。README 实测：三段协议（Stage 1 全员并行首答 → Stage 2 匿名互评排名 → Stage 3 Chairman 综合），FastAPI+React+OpenRouter。作者原话：*"99% vibe coded… I'm not going to support it… I don't intend to improve it."* → **无 license = 法律上不可复用代码；三段协议本身是 Socrates Review Board 模式的优质设计参考**。
- [composable-models/llm_multiagent_debate](https://github.com/composable-models/llm_multiagent_debate)：543★，ICML 2024 论文代码，无 license，研究脚本。
- [chain-ml/council](https://github.com/chain-ml/council)：856★，Apache-2.0，最后 push 2025-01-16——停滞约 18 个月。
- 长尾（列出即止，均不足以做基座）：Detrol/quorum-cli（111★，CLI 辩论）、DmitryBMsk/llm-council-plus（115★，MIT，三段 council）、TrentPierce/PolyCouncil（40★，LM Studio 投票）、rockbenben/legend-talk（41★）、qq260345385/AI-Roundtable（3★）等。
- **含义**：这个空缺正是 Socrates 的产品机会；同时说明没有「抄近路」可走。

---

## 5. 推荐：按「改造最快到 MVP」排序

> 共同前提：**任何路线都逃不掉自建群聊前端**（无一个候选具备「房间+角色+轮次」UI）；而 MVP 编排层（确定性 selection 循环 + 黑板解析）本身很薄。因此决策核心是：**provider 层拿谁的 + 编排语义抄谁的 + 是否引入 Python 后端**。

### 方案一（推荐）：TypeScript 单栈自建 + Vercel AI SDK 做 provider 层 + 深度借鉴三个对象

- **组成**：[vercel/ai](https://github.com/vercel/ai)（25,421★，**Apache-2.0**，LICENSE 实测，push 2026-07-08）统一多厂商流式接口（OpenAI-compatible 覆盖 DeepSeek/Qwen/Kimi/GLM，Anthropic/Google 一方 provider）；编排引擎按 04 文档直接实现为 TS 状态机；Tauri 桌面壳；UI 交互借鉴 Open WebUI Channels（群聊时间线 + @模型）与 big-AGI Beam（多模型流式并排）；编排语义借鉴 AutoGen `RoundRobinGroupChat`/`SelectorGroupChat`（MIT 源码）与 llm-council 三段协议。
- **为什么最快**：MVP 无工具调用，编排 = `for round → for speaker → build prompt → stream → parse → blackboard`，自写量约等于接入并驯服一个 Python 框架的量；单语言栈免去「Python 后端 + TS 前端」双进程架构税与 Python 桌面打包问题；桌面本地优先（NFR-005、隐私）天然满足；全部依赖 MIT/Apache，商用零风险。
- **代价**：编排层无上游可依赖，Debate/ReviewBoard/Pipeline 的每个策略都是自己的代码；V2 的工具生态（MCP、沙箱执行）也要自己接（TS 侧有官方 MCP SDK，可控）。

### 方案二：Microsoft Agent Framework 编排后端 + 自建前端（最稳过渡到 V1/V2）

- **组成**：MAF Python（MIT）`orchestrations.GroupChatOrchestrator`（selection_func/max_rounds/termination 与 04 文档一一对应，`AgentBasedGroupChatOrchestrator` 直接给出未来的动态 Chair）+ 一方 provider 包（anthropic/gemini/ollama/openai/bedrock/mistral）+ workflow checkpointing（对应 FR-011 回放）；前端自建（Tauri/Electron），经 MAF 的 `ag-ui` 事件协议或自定义 SSE 通道对接。
- **为什么选它**：当权重放在 V1/V2（工具调用、MCP、执行沙箱、人机审批、持久化恢复）时，MAF 的一方能力最全、由微软长期维护（AutoGen+Semantic Kernel 双合流的唯一正统后继）、MIT 无任何商用限制。黑板机制官方预留扩展点（`BaseGroupChatOrchestrator`）。
- **代价**：MVP 阶段比方案一慢——多一个 Python 服务进程、桌面分发要打包 Python 运行时、需剥离 Azure/企业糖；框架 API 仍在快速演进（Python 1.10.0）。

### 备选（第三位）：AgentScope 2.0 全家桶 + 自写薄编排

若团队偏 Python 且**重视中国厂商一方支持与审批权限系统**：AgentScope（Apache-2.0）的 model 层（DashScope/DeepSeek/Moonshot/xAI/Anthropic/Gemini/Ollama）、event 流、permission 审批（映射 FR-009）、workspace 沙箱都直接可用；代价是确定性群聊原语在 2.0 已被移除（v1 分支的 MsgHub 属维护线），编排永远自维护，且 2.0 发布仅两月 API 未稳。

### 不推荐的路线

- **fork 任何带 UI 的成品**（Open WebUI / LibreChat / LobeHub / Dify / Cherry Studio）：要么 license 卡死商用 fork（LobeHub 衍生品需授权、Open WebUI 品牌条款、Dify 前端限制、Cherry AGPL），要么架构形态错位（多用户 web 服务器 ≠ 本地桌面）且群聊编排层为零——在 15-40 万行陌生代码库里植入 Socrates 的核心差异化（策略引擎/黑板/审批），慢于自建。
- **fork AutoGen / AG2**：前者官方维护模式冻结，后者 0.x→v1.0 换血期两头落空。二者仅作设计参考。

### License 兼容性速查（商用视角，均经 LICENSE 原文/API 核实）

| 可放心用（MIT/Apache） | 受限/不可用 |
|---|---|
| MAF、AutoGen 代码、vercel/ai、big-AGI、LibreChat、LangGraph、CrewAI、CAMEL、AgentScope、AG2、OpenAI Agents SDK、Jan | LobeHub（衍生品需商业授权）、Open WebUI（品牌条款）、Dify（LOGO/多租户）、Cherry Studio（AGPL-3.0）、karpathy/llm-council（无 license）、composable-models/llm_multiagent_debate（无 license） |

---

## 附：主要一手来源

- MAF group chat 源码：<https://github.com/microsoft/agent-framework/blob/main/python/packages/orchestrations/agent_framework_orchestrations/_group_chat.py>；provider 包目录：<https://github.com/microsoft/agent-framework/tree/main/python/packages>；DevUI 定位：<https://github.com/microsoft/agent-framework/blob/main/python/packages/devui/README.md>
- AutoGen maintenance mode 与分层架构：<https://github.com/microsoft/autogen/blob/main/README.md>；group chat 实现：<https://github.com/microsoft/autogen/tree/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat>
- AG2 v1 重构声明：<https://github.com/ag2ai/ag2/blob/main/README.md>；release：<https://github.com/ag2ai/ag2/releases>；PyPI：<https://pypi.org/project/ag2/>
- AgentScope 2.0 模块与 model 目录：<https://github.com/agentscope-ai/agentscope/tree/main/src/agentscope>；v1 pipeline（MsgHub）：<https://github.com/agentscope-ai/agentscope/tree/v1/src/agentscope/pipeline>
- Open WebUI Channels/Multi-Model 与品牌条款：<https://github.com/open-webui/open-webui/blob/main/README.md>、<https://github.com/open-webui/open-webui/blob/main/LICENSE>
- LibreChat multi-response：<https://www.librechat.ai/changelog/v0.7.4>、<https://www.librechat.ai/changelog/config_v1.1.7>
- LobeHub / Dify / Cherry Studio / Jan / vercel-ai LICENSE 原文：各仓库 `/LICENSE`
- big-AGI Beam：<https://github.com/enricoros/big-AGI/blob/main/README.md>
- llm-council 协议与免责声明：<https://github.com/karpathy/llm-council/blob/main/README.md>
- CAMEL societies：<https://github.com/camel-ai/camel/tree/master/camel/societies>；LangGraph 定位：<https://github.com/langchain-ai/langgraph/blob/main/README.md>；Swarm 弃用声明：<https://github.com/openai/swarm/blob/main/README.md>；MetaGPT SOP：<https://github.com/FoundationAgents/MetaGPT/blob/main/README.md>
- 所有 stars/pushed/release 数据：GitHub REST API，查询时间 2026-07-08
