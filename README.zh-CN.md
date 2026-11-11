<p align="center">
  <a href="README.md">English</a> &nbsp;·&nbsp; <strong>简体中文</strong>
</p>

<p align="center">
  <img src="doc/assets/readme/hero-zh-CN.svg" alt="Socrates 苏格拉底：一起思考，一起创造。多 AI 讨论、多 Agent 协作、自定义 AI 角色的桌面工作台。" width="100%">
</p>

<p align="center">
  <strong>一个好想法，值得听见不同的声音。</strong><br>
  把不同厂商的 AI 请进同一个房间，为它们赋予身份、角色和共同目标。<br>
  在 <strong>Chat</strong> 中碰撞观点，在 <strong>Work</strong> 中把想法变成成果。
</p>

<p align="center">
  <a href="#开始使用">开始使用</a> &nbsp; / &nbsp;
  <a href="#01--chat让观点相遇">探索 Chat</a> &nbsp; / &nbsp;
  <a href="#02--work让讨论走向行动">探索 Work</a> &nbsp; / &nbsp;
  <a href="#03--你的模型你的角色">创建你的角色</a>
</p>

---

## 01 / Chat。让观点相遇。

**同一个问题，不同的模型，一场彼此接得住的讨论。**

请一位架构师、一位研究者和一位质疑者加入房间。让它们提出方案、挑战假设、补充细节，在共同的对话中形成更完整的判断。每个观点都有清楚的身份，每个成员的声音都能被看见。

![Socrates Chat：两位 AI 角色围绕阅读应用的设计展开讨论、提出质疑并汇总方向。](doc/assets/readme/chat.png)

- **不同模型，同桌讨论。** 将已配置的 OpenAI 兼容供应商和 Anthropic 模型组合进一个房间。
- **由你决定谁来回应。** 交给默认成员，通过 `@` 选择指定成员，或发起有轮数边界的团队讨论。
- **专注交流与思考。** Chat 不绑定工作区，也没有本地执行工具，适合头脑风暴、方案比较与角色对话。

<sub>截图为真实应用界面，展示内容使用演示对话与示例模型回复。</sub>

## 02 / Work。让讨论走向行动。

**有分工、有工作区，也有你能看懂和确认的执行计划。**

连接本地项目，选择适合的工作方式：让一位 Agent 直接处理任务、先讨论思路，或明确启动团队协作。Manager 将任务拆成工作包，成员在计划获批后按分工执行。

![Socrates Work：审批前查看 Manager 计划、成员分工、依赖关系和验收条件。](doc/assets/readme/work.png)

<img src="doc/assets/readme/workflow-zh-CN.svg" alt="可选讨论 → Manager 拆分工作包 → 审批 → 成员执行 → 可选审核。" width="100%">

- **谁负责什么，一目了然。** 每个工作包都有负责人、依赖关系、预期结果和验收条件。
- **关键步骤由你掌握。** 查看计划、批准执行、跟踪成员进度，并在需要时暂停或恢复任务。
- **直接在你的项目里工作。** Native Runtime 支持读取和修改文件、执行命令，并提供权限控制。可选的 Agent 审核能要求有次数上限的返工。

成员共享工作区，执行会排队以避免写入冲突；多 Agent 协作不代表同时修改相同文件。

<sub>截图来自隔离的演示工作区，所展示的任务计划为示例。</sub>

## 03 / 你的模型。你的角色。

**模型提供能力，而你决定它以怎样的身份加入讨论。**

<img src="doc/assets/readme/personas-zh-CN.svg" alt="为 AI 赋予个性：月影智者、晴空灵狐和青苔斥候。支持大量中英文名字和辨识度鲜明的像素头像。" width="100%">

它可以是严谨的审阅者、擅长发散的研究伙伴，也可以是你亲手设定的角色。选择模型、编写角色与系统提示，再为它配上一个一眼就能认出的名字和头像。

- **名字不再只有几个。** 英文、简体中文、繁体中文各有 2,048 种基础组合，自动避开已使用的昵称。
- **大量可辨识的像素头像。** 在本地生成不同图案，轮廓和配色同时变化，区分成员不只依靠颜色。
- **保留你自己的风格。** 选择经典角色，或上传不超过 2 MB 的 PNG、JPEG、WebP、GIF。名字和头像可以分别随机。
- **在需要时创建角色。** 角色库、创建房间和房间成员管理中都可以使用同一个角色编辑器。

<details>
<summary><strong>看看角色编辑器</strong></summary>

![Socrates 角色编辑器：随机名字语言、像素头像、图片上传、模型、角色与系统提示。](doc/assets/readme/character-editor.png)

</details>

## 两种模式，清楚的选择。

| | Chat | Work |
| :-- | :-- | :-- |
| 适合做什么 | 探索想法、辩论、评议、角色对话 | 在本地项目中完成具体任务 |
| 成员 | 一位或多位 AI 角色 | 一位或多位 AI Agent |
| 如何回应 | 指定成员或团队讨论 | 直接执行、讨论或团队计划 |
| 本地文件与命令 | 不提供 | 通过 Native Runtime 和权限控制使用 |
| 你掌握什么 | 参与成员与讨论设置 | 工作区、计划审批、执行与审核 |

增加成员不会自动改变协作策略。房间如何工作，始终由你明确选择。

## 开始使用

Socrates 正在持续开发中，目前的开发流程以 **macOS** 为主。实现细节见[架构文档](doc/architecture.md)。

安装 [Bun](https://bun.sh)、[Rust](https://rustup.rs)，并准备好 macOS 开发工具，然后运行：

```bash
git clone https://github.com/Haosen-Zhang/Socrates.git
cd Socrates
bun install
bun run dev
```

首次启动桌面端需要编译 Rust，可能耗时几分钟。

1. **连接模型。** 打开「设置 → 模型供应商」，添加供应商和自己的 API Key。
2. **组建角色阵容。** 打开角色库，选择模型，设置名字、头像、角色与系统提示。
3. **创建房间。** 选择 Chat 开始交流；需要执行时，选择 Work 并绑定本地工作区。

macOS 上的 API Key 存在系统 Keychain 中。对话与任务历史保存在本地；你发送的提示和上下文会交给所配置的模型供应商处理，模型调用使用你的供应商凭证与计费额度。

## 为你掌握的工作区而构建。

**Tauri + React** 提供桌面界面，**Bun + Hono** 承载应用服务，**SQLite** 保存本地状态，共享的 **TypeScript** 领域层统一房间和执行规则。

| 包 | 职责 |
| :-- | :-- |
| [`apps/desktop`](apps/desktop) | 桌面界面、房间时间线、角色编辑器与工作区视图 |
| [`apps/sidecar`](apps/sidecar) | 供应商、编排、持久化、审批与原生 Agent 运行时 |
| [`packages/core`](packages/core) | 共享类型、契约、校验与状态机；无 UI 和 I/O 依赖 |

```bash
bun test
bun run typecheck
bun run --cwd apps/desktop build
```

进一步阅读：[当前架构](doc/architecture.md)、[Chat / Work 实现](doc/chat-work-collaboration-acceptance.md)、[可靠性验证](doc/chat-work-reliability-repair-acceptance.md)、[运行时演进路线](doc/native-runtime-and-langgraph-roadmap.md)。生产执行内核为 Socrates Native Runtime；路线文档区分已实现能力和后续计划。

遇到问题或有新的想法？欢迎[创建 Issue](https://github.com/Haosen-Zhang/Socrates/issues)。贡献代码请遵循[仓库开发流程](AGENTS.md)。

---

<p align="center">
  <strong>不同的智慧，共同向前。</strong><br>
  <sub>为那些值得继续的讨论而做。</sub><br><br>
  <a href="README.md">Read in English →</a>
</p>

成本感知 Work：[使用指南](doc/cost-aware-user-guide.md) · [P08 验收证据](doc/cost-aware-p08-scenarios.md)。
