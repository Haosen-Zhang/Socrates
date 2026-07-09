# AGENTS.md

Socrates 是一个多模型群聊式 Agent 工作台。当前仓库只包含产品与工程设计文档（见 `docs/`），暂无应用代码。

## Agent skills

### Issue tracker

Issues 追踪在 GitHub Issues（`Haosen-Zhang/Socrates`），使用 `gh` CLI；外部 PR 不作为需求来源。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个默认标签：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单 context 布局：根目录 `CONTEXT.md` + `docs/adr/`（按需惰性创建）。详见 `docs/agents/domain.md`。
