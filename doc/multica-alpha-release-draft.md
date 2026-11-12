# Next source-based Alpha — release draft (unpublished)

Work now separates reusable Squads, persistent WorkItems and individual Runs. Save an owner without calling a model, or preview and explicitly start the authorized Agent/Leader route. Review member availability, queued instructions, attempts, blockers and human-review requests through task details and the local Inbox.

Squad policies connect to existing Economy/Balanced/Quality/Custom routing. Costs retain unknown usage/prices, verification stays tied to actual artifacts, and a completed Run does not become a Done WorkItem until human acceptance. Root and child evidence changes reopen an earlier acceptance. Flight Recorder, confirmed Project Memory and isolated Arena experiments use the same production services.

The final integration pass reduces the120-task list payload from12.1MB to444KB by loading history only in task detail. Fresh and Alpha-schema databases, persistent workflows, event reconnect, long streams, dark/light/narrow layouts and browser keyboard/composition behavior have current controlled tests. Full evidence and limitations are in [M07 acceptance](multica-m07-acceptance.md).

To run from source: install Bun and Rust, run `bun install` then `bun run dev`, configure your own Provider in Settings, and select a local workspace for Work. Provider usage is billed to your configured account. Native tools continue through approval and workspace write leases. No paid provider quality or savings claim is made by synthetic tests.

Upgrade uses additive migrations through040 and an automatic consistent SQLite backup. Previous verified reviews without the complete evidence revision require fresh acceptance; their history is retained. Follow the [backup and rollback guide](multica-m07-acceptance.md#upgrade-backup-and-rollback); an older binary must use a restored pre-upgrade copy, and restoring the database does not undo workspace files.

This draft does not assign a new version, publish a tag, or claim a signed/notarized installer. OS IME candidate windows, VoiceOver, native packaging and clean-machine installation remain unverified. Dependency notice gaps and the absent root project license must be resolved before distributable release; see [license audit](../third-party/README.md).

## 中文说明

本次 Alpha 草稿把 Squad 模板、长期工作事项和单次 Run 分开：只分配不调用模型，显式预览后才启动；备注、临时提及、排队指示、停止重启、成员状态和本机 Inbox 均连接既有服务。费用未知时保持未知，真实产物验证与人工验收独立，根任务或子任务证据变化会重新打开审核。

120任务列表由12.1MB降至444KB，历史只在详情读取。已完成受控模型下的当前集成、升级恢复、长流、重连和界面检查。仍须从源码运行，配置自己的 Provider 与本地工作区；未发布安装包，未验证真实付费模型、原生输入法候选窗口或屏幕阅读器。回退需使用旧版兼容的独立备份副本，工作区文件需另行保护。分发前还需解决许可证与第三方声明缺口。
