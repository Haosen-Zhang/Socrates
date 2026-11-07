# Native 工具契约审计：Phase 5–8

审计范围为 16 个公开 Native 工具定义：5 个工作区读取工具、8 个修改工具、2 个结构化命令入口，以及 `read_tool_result`。`run_shell` 仅作为 `run_command` 的结构化参数兼容别名。`createNativeBuiltinTools` 在生产 `index.ts` 统一注册这16个工具，写工具工厂已应用metadata overlay，并替换旧同名命令入口。MCP 外部工具不伪造 Native 输出契约。

共同规则：输入与输出使用 `packages/core/src/tools.ts` 的同一递归 schema 词汇；Native 对象显式关闭额外属性。`ToolExecutor` 在成功入库前验证规范输出，再单独渲染模型预览。`timeoutMs` 限制单次 attempt，重试不会共用一个总时限。同步文件系统操作不能在系统调用中途抢占；超时后的未知结果不得解释为“没有发生修改”。

表中 R/W/S 分别表示 `workspace_read` / `workspace_write` / `shell`。所有读取工具均为 low/read；修改工具均为 non_idempotent。简单工具由参数描述说明语义；复杂工具另附 schema example。

| 工具 | 用途 | risk / idempotency / capability | 单次超时 | 输入 schema | 规范输出 schema | 描述与示例 | 取消行为 | 主要失败与实现边界 |
|---|---|---|---|---|---|---|---|---|
| workspace_info | 相对根标记 | low / read / R | 30s | 空对象 | root、pathKind 固定枚举 | 准确；简单工具 | 入口检查 signal | 取消；不暴露本地绝对根 |
| list_directory | 递归列目录 | low / read / R | 30s | 相对目录；`.` 明确表示根 | entries、coverage、resultTruncated、truncated | 明示 2000 entry 上限、排除项 | 每目录及 entry 检查 | 不存在/非目录、变化/排除项计数；不得推断完整遍历 |
| search_files | 路径名子串搜索 | low / read / R | 30s | 不区分大小写的 literal query；说明空串 | matches、coverage、resultTruncated、truncated | 明示 2000 entry / 200 match | 遍历和扫描检查 | 第 201 个真实匹配才证明结果截断；遍历截断独立报告 |
| search_text | UTF-8 行子串搜索 | low / read / R | 30s | 区分大小写的 literal query，非正则 | path/line/text/textTruncated 匹配数组及 coverage | 明示 512KiB/file、200 match、500 字符预览 | 遍历、文件、逐行检查 | binary/non-UTF8/读取失败分开计数；部分文件不能支持全文件“未找到” |
| read_file | 文本前缀与整文件身份 | low / read / R | 30s | 工作区相对文件路径 | path、text、byteSize、sha256、truncated | 明示 text 最多512KiB，但 hash 覆盖整文件 | 入口检查；同步 descriptor 读取无中途抢占 | secret/symlink/hardlink/binary/non-UTF8/文件变化；policy 用稳定 descriptor 计算 hash |
| read_tool_result | 读取完整工具结果的分页 | low / read / R | 30s | opaque ref、byte offset、4..32768 maxBytes；默认16384 | ref、text、byteSize、offset、nextOffset、truncated | 示例有效；明确 refs 不是文件路径、offset 是字节 | 中央 deadline；SQLite 同步分页无中途抢占 | ref/range 错误、未完成 artifact、跨 Session/workspace 读取均拒绝；无工具主体本地 signal 检查 |
| write_file | 原子 UTF-8 替换 | high / non_idempotent / W | 30s | path、完整 content、可选 expectedSha256（null=仅新建） | action、path、nullable oldSha256、newSha256、diff、diffTruncated | schema example；真实有界统一 diff | derived signal、operationId与expectedSha256已传入policy；发布前检查 | stale hash/链接/路径变化/阶段写入失败。省略 expectedSha256 保留经批准覆盖；真实主体返回hash与diff，生产工厂16个输出契约回归已通过 |
| create_directory | 新建目录与父目录 | high / non_idempotent / W | 30s | 新目录 path | action、kind、path | 准确；简单工具 | policy 检查点；无 syscall 抢占 | 目标存在、路径越界、发布冲突 |
| copy_path | 有界文件/目录树复制 | high / non_idempotent / W | 30s | source、新 destination | action、source、destination、kind、entries、byteSize | 256 entries / 50MiB；有效示例 | 同步快照；policy 发布检查点 | secret/链接/树边界/目标冲突 |
| move_path | 不覆盖的移动或改名 | destructive / non_idempotent / W | 30s | source、新 destination | action、from、to、kind | 明示 self-move 拒绝；有效示例 | policy 检查点；无 syscall 抢占 | 源/目标变化、移入自身、路径违规 |
| create_archive | 新 ZIP | high / non_idempotent / W | 30s | .zip path、1..32 sources | action、format、path、entries、sourceBytes、byteSize | 256 entries / 50MiB；有效示例 | 同步 snapshot/压缩后发布；依赖 signal 传入 policy | 扩展名、重复 source basename、大小/数量、目标存在；不支持解压 |
| create_document | plain-text DOCX | high / non_idempotent / W | 30s | .docx path、可选 title、字符串 paragraphs | action、format、path、paragraphs、byteSize | 1000段 / 1MiB UTF-8；有效示例 | 异步打包后 policy 发布检查 | 扩展名、段数/字节、覆盖、打包失败；不包含模型隐藏推理 |
| create_spreadsheet | XLSX / 单 sheet CSV | high / non_idempotent / W | 30s | 实际 sheets→rows→string/number/bool/null cells；format enum | action、format、path、sheets、rows、byteSize | 10 sheets、5000 rows/sheet、100 cols/row、50000 cells、5MiB；有效示例 | 异步 XLSX 序列化后 policy 发布检查 | formula-like 字符串、名称/扩展名/格式/跨字段边界/覆盖；schema 表达真实嵌套，语义 validator 补充总量和格式关系 |
| delete_path | 一个文件或空目录 | destructive / non_idempotent / W | 30s | 相对目标 path | action、path、kind | 明示非递归；简单工具 | policy 检查点；无 syscall 抢占 | 非空目录、unsafe target、替换攻击 |
| run_command | 经精确审批的验证命令 | high / non_idempotent / S | 最大120s；输入可缩短 | executable enum、exact argv、cwd、timeoutMs100..120000；示例 bun test/npm script | argv/cwd/exitCode/signal、stdout/stderr 预览、截断/捕获/超时/取消标志、duration、可选 refs | shell=false；git 仅 status/rev-parse；说明项目代码可修改工作区 | derived deadline → TERM/KILL process group → cleanup；超时保留 partial result | 不可用 runtime/sandbox、参数/cwd、秘密/越界、超时/取消、capture失败；非零退出仍返回证据 |
| run_shell | run_command 兼容别名 | high / non_idempotent / S | 同上 | 同一结构化 schema；不接受 shell 字符串 | 同一规范结构 | 别名准确；共享示例 | 同上 | 同上；不恢复任意 shell 命令串 |

## 覆盖与完整结果

`coverage.traversalTruncated` 表示仍有 eligible entry 未遍历；`entriesScanned` 包括排除项和确定遍历截断所用的 lookahead；`filesScanned` 表示列出的文件/名称检查数量，或文本读取尝试数量（含失败）。`fileContentTruncated`、`binaryFilesSkipped`、`unsupportedFilesSkipped`、`skippedEntries`、`matchTextTruncated` 区分文件前缀、binary、非UTF-8、其他排除/失败及返回行预览截断。

`resultTruncated` 只表示真实匹配结果超出200上限；正好200个完整匹配为 false。兼容字段 `truncated` 保守合并任何覆盖缺口、结果省略或预览截断。空结果必须结合 coverage 解读。

长输出预览在 `ToolExecutor` 处有 byte/line 上限；完整规范 JSON 存私有 SQLite artifact。子进程 stdout/stderr 各自流式存储，每流最大64MiB，超过则明确终止而非假称完整。`read_tool_result` 只接受同 Session 与同 workspace identity 的已完成 ref；后续页面通过 nextOffset 继续，不把任意文件路径当 ref。

## 证据与边界

- `packages/core/src/tool-schema.test.ts` 覆盖递归结构、nullable cell、enum、字符串/数组/数字约束、自有 required 属性和额外属性策略。
- `tools/read-only-builtins.test.ts` 覆盖无匹配但遍历截断、恰好达到结果上限、文件前缀/binary/non-UTF8/行预览、扫描数和规范 read identity。
- `apps/sidecar/src/tools/native-builtins.test.ts` 的 `production native registry validates all sixteen builtin results and preserves mutation evidence` 用生产工厂调用全部16个真实主体并验证输入/输出schema，包括文件修改、ZIP/DOCX/XLSX、captured命令输出与read_tool_result；另有真实CSV及非法schema用例。此测试直接调用主体，不冒称每个工具都单独经过executor审批全链路。
- `tools/executor-policy.test.ts` 覆盖 `TOOL_OUTPUT_INVALID` 在 durable success 前失败、单次 deadline、完整输出 ref，以及归一化参数下3/5/8阈值、输入变化重置、第3次提示不累计completed replay、stale write不重试、结构化权限拒绝零dispatch。
- `tools/output-store.test.ts` 覆盖ref/range/Session/workspace隔离、stdout/stderr独立artifact、真实disk SQLite关闭重开、多字节分页、18→19迁移保留legacy输出及存储失败整笔rollback。
- `tools/journal-workspace-recovery.test.ts` 证明真实executor结果事件失败后，重开SQLite由journal核验FS证据；覆盖applied/not_applied/unknown、参数/工作区绑定、恢复事件事务失败、8种Native修改映射和已提交canonical/ref保留。
- `runtime/native-tool-policy.test.ts` 证明精确fresh命令审批、明确denial、结构化非法输入、规范失败/ref进入下一次SDK采样及历史修复、不合作工具阻断后续模型活动。
- `tools/workspace-command-runner.test.ts` 的4个真实macOS sandbox用例已在允许sandbox-exec的环境通过，验证bun/npm/Python/Git、网络与文件隔离。所有测试共754通过，无跳过；不推断未安装工具链的所有配置均可用。

生产宿主通过 `createNativeBuiltinTools` 使用write metadata overlay、structured command定义及Session/workspace范围的read_tool_result；完整ref投影也进入SDK采样和修复历史。最终验收状态见 [验收矩阵](single-agent-phase5-8-acceptance.md)。

成功修改的恢复记录由journal在durable result之后核验清理；清理失败可延后重试，未提交的证据保留。正常命令退出同样等待所属进程组清理；不因主进程关闭stdio就提前报告完成。审批前参数/语义失败返回规范错误供模型纠正，移除非法审批请求并保持调用/结果配对。
