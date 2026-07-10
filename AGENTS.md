# AGENTS.md

Socrates 是一个多模型群聊式 Agent 工作台：把不同厂商的 LLM 拉进同一个房间，按可控的编排策略讨论同一个任务，最后由指定模型总结。MVP（issue #2 及 #3–#9）已完成：Provider 管理、Agent、Room、Round Robin / Debate 编排、流式群聊 UI、任务取消/重试、历史回放、语言切换。

## 代码结构

TypeScript 单栈，Bun workspaces，三个包：

| 包 | 职责 |
| --- | --- |
| `packages/core` | 纯 TS 领域逻辑与类型：编排引擎（`orchestration.ts`）、SSE/网关契约（`chat.ts`）、Provider 模型（`provider.ts`）。**零 IO / 零 UI 依赖**，是主要单测缝。 |
| `apps/sidecar` | Bun 进程，编排引擎的宿主。Hono 起 HTTP + SSE 服务（`rooms.ts` / `providers.ts` / `agents.ts`），`bun:sqlite` 持久化（`db.ts`），API Key 存系统 Keychain（`secrets.ts`），Vercel AI SDK 实现网关（`gateway-aisdk.ts`）。 |
| `apps/desktop` | Tauri + React + Zustand + Tailwind。Rust 侧（`src-tauri`）启动时拉起 sidecar，经 stdout 握手把随机端口+token 交给前端；前端 `store.ts` 消费 SSE。 |

关键设计与取舍见 `docs/adr/`（自建、Bun sidecar、MVP 无黑板）；架构/领域/编排细节见 `docs/02`–`docs/04`。

## 开发流程

- **一票一分支**：从 `main` 切分支实现一个 issue → PR → 合并；不要直接改 `main`。
- **合并前必须绿**：`bun test`（core + sidecar）、`bun run typecheck`、`bun run --cwd apps/desktop build` 三者都通过。
- 非平凡逻辑留一个可运行的 `*.test.ts`（bun test，无框架）。

## 跑起来

前置：[Bun](https://bun.sh) 与 [Rust](https://rustup.rs)（Tauri 需要 cargo 在 PATH）。

```bash
bun install
bun run dev        # 启动桌面应用（Tauri 首次会编译 Rust，需几分钟）
bun test           # 全部测试
bun run typecheck  # 类型检查
```

## 测试用 API Key

仓库里**没有**任何 key（安全约定）。要真机测试讨论功能，需在应用「设置 → 模型供应商」里手动添加 Provider 和 key（存进系统 Keychain，不落仓库），或由发起方另行提供。连接测试打供应商的列模型端点，不消耗 token。

## Agent skills

### Issue tracker

Issues 追踪在 GitHub Issues（`Haosen-Zhang/Socrates`），使用 `gh` CLI；外部 PR 不作为需求来源。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个默认标签：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单 context 布局：根目录 `CONTEXT.md` + `docs/adr/`（按需惰性创建）。详见 `docs/agents/domain.md`。
