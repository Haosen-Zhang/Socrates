import "./memory.css";
const memoryLabels: Record<string, [string, string]> = {
	保存新版本: ["Save new version", "儲存新版本"],
	添加待确认记忆: ["Add proposed memory", "新增待確認記憶"],
	固定: ["Pin", "固定"],
	取消固定: ["Unpin", "取消固定"],
	来源: ["Source", "來源"],
	无可携带来源: ["No portable source", "無可攜來源"],
	目标: ["Goal", "目標"],
	约束: ["Constraint", "約束"],
	决策: ["Decision", "決策"],
	事实: ["Fact", "事實"],
	待办: ["Todo", "待辦"],
	产物引用: ["Artifact reference", "產物引用"],
	待确认: ["Proposed", "待確認"],
	已确认: ["Confirmed", "已確認"],
	已替代: ["Superseded", "已取代"],
	已拒绝: ["Rejected", "已拒絕"],
	已停用: ["Expired", "已停用"],
	用户: ["User", "使用者"],
	候选: ["Proposal", "候選"],
	导入: ["Import", "匯入"],
	验收证据: ["Verification evidence", "驗收證據"],
	项目记忆: ["Project memory", "項目記憶"],
	搜索记忆: ["Search memory", "搜索記憶"],
	类型: ["Kind", "類型"],
	内容: ["Content", "内容"],
	"允许的供应商（未选择表示所有已授权供应商）": [
		"Allowed providers (none selected means all authorized providers)",
		"允許的供應商（未選擇表示所有已授權供應商）",
	],
	与当前条目冲突的记忆: ["Conflicting entries", "与當前條目衝突的記憶"],
	从已有消息或验收结果提出候选: [
		"Propose from messages or verified results",
		"從已有消息或驗收結果提出候選",
	],
	消息: ["Message", "消息"],
	已验收任务: ["Verified task", "已驗收任務"],
	选择来源: ["Choose source", "選擇來源"],
	读取来源并提出候选: ["Create proposal from source", "讀取來源並提出候選"],
	任务读取的记忆: ["Memory read by a task", "任務讀取的記憶"],
	选择任务: ["Choose task", "選擇任務"],
	查看冻结清单: ["View frozen manifest", "查看凍結清单"],
	为重新规划创建新快照: [
		"Create snapshot for replanning",
		"为重新規劃創建新快照",
	],
	"没有匹配的项目记忆。": [
		"No matching project memories.",
		"沒有匹配的項目記憶。",
	],
	批量确认候选: ["Confirm all proposals", "批量確認候選"],
	批量拒绝候选: ["Reject all proposals", "批量拒絕候選"],
	编辑: ["Edit", "編輯"],
	确认: ["Confirm", "確認"],
	停用: ["Deactivate", "停用"],
	版本历史: ["Version history", "版本历史"],
	版本记录: ["Version records", "版本記錄"],
	"导入 / 导出（先预览，再确认）": [
		"Import / export (preview before confirming)",
		"導入 / 導出（先預覽，再確認）",
	],
	"生成 JSON 快照": ["Generate JSON snapshot", "生成 JSON 快照"],
	预览导入: ["Preview import", "預覽導入"],
	将预览内容导入为候选: ["Import preview as proposals", "将預覽内容導入为候選"],
	"仅确认且获目标供应商许可的背景会进入任务。候选和导入内容默认待确认；权限与预算不会被记忆覆盖。":
		[
			"Only confirmed background authorized for the target provider enters a task. Imports remain proposals; memory cannot override permissions or budgets.",
			"僅確認且獲目標供應商許可的背景会進入任務。候選和導入内容默認待確認；權限与預算不会被記憶覆蓋。",
		],
};
import { useEffect, useState } from "react";
import type { MemoryEntry } from "@socrates/core";
import { useStore } from "../store";
import { sidecarFetch, requireOk } from "../transport";
export function ProjectMemoryPanel({ roomId }: { roomId: string }) {
	const handshake = useStore((s) => s.handshake),
		providerList = useStore((s) => s.providers),
		lang = useStore((s) => s.lang);
	const L = (text: string) =>
		lang === "en"
			? (memoryLabels[text]?.[0] ?? text)
			: lang === "zh-TW"
				? (memoryLabels[text]?.[1] ?? text)
				: text;
	const display = (value: string) =>
		L(
			(
				{
					goal: "目标",
					constraint: "约束",
					decision: "决策",
					fact: "事实",
					todo: "待办",
					artifact_reference: "产物引用",
					proposed: "待确认",
					confirmed: "已确认",
					superseded: "已替代",
					rejected: "已拒绝",
					expired: "已停用",
					user: "用户",
					agent_proposal: "候选",
					import: "导入",
					verified_artifact: "验收证据",
				} as Record<string, string>
			)[value] ?? value,
		);
	const [entries, setEntries] = useState<MemoryEntry[]>([]),
		[query, setQuery] = useState(""),
		[content, setContent] = useState(""),
		[kind, setKind] = useState<MemoryEntry["kind"]>("constraint"),
		[editing, setEditing] = useState<MemoryEntry | null>(null),
		[error, setError] = useState(""),
		[exchange, setExchange] = useState(""),
		[preview, setPreview] = useState<unknown>(null),
		[history, setHistory] = useState<unknown>(null),
		[providers, setProviders] = useState(""),
		[conflicts, setConflicts] = useState(""),
		[source, setSource] = useState(""),
		[sourceKind, setSourceKind] = useState("message"),
		[root, setRoot] = useState(""),
		[sources, setSources] = useState<{
			messages: Array<{ id: string; content: string }>;
			tasks: Array<{ id: string; title: string; status: string }>;
		}>({ messages: [], tasks: [] });
	async function api<T>(path: string, body?: unknown): Promise<T> {
		if (!handshake) throw Error("连接未就绪");
		return requireOk<T>(
			await sidecarFetch(
				handshake,
				`/project-memory/${encodeURIComponent(roomId)}${path}`,
				body === undefined
					? {}
					: {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(body),
						},
			),
		);
	}
	async function refresh() {
		setEntries(await api<MemoryEntry[]>(`?q=${encodeURIComponent(query)}`));
	}
	async function action(fn: () => Promise<void>) {
		try {
			setError("");
			await fn();
		} catch (e) {
			setError(String(e));
		}
	}
	useEffect(() => {
		let current = true;
		setEntries([]);
		setEditing(null);
		setHistory(null);
		setExchange("");
		setPreview(null);
		void api<typeof sources>("/sources")
			.then((v) => {
				if (current) setSources(v);
			})
			.catch(() => {});
		void api<MemoryEntry[]>(`?q=${encodeURIComponent(query)}`)
			.then((v) => {
				if (current) setEntries(v);
			})
			.catch((e) => {
				if (current) setError(String(e));
			});
		return () => {
			current = false;
		};
	}, [roomId, query, handshake]);
	async function save(
		e: MemoryEntry,
		status: MemoryEntry["status"],
		pinned = e.pinned,
	) {
		await api("/save", {
			id: e.id,
			version: e.version,
			status,
			entry: { ...e, pinned },
		});
		await refresh();
	}
	return (
		<section className="space-y-3 p-4" data-project-memory>
			<h2 className="text-lg font-bold">{L("项目记忆")}</h2>
			<p>
				{L(
					"仅确认且获目标供应商许可的背景会进入任务。候选和导入内容默认待确认；权限与预算不会被记忆覆盖。",
				)}
			</p>
			{error && <p role="alert">{error}</p>}
			<label>
				{L("搜索记忆")}
				<input
					className="pixel-input"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</label>
			<div className="space-y-2">
				<label>
					{L("类型")}
					<select
						value={kind}
						onChange={(e) => setKind(e.target.value as MemoryEntry["kind"])}
					>
						{[
							"goal",
							"constraint",
							"decision",
							"fact",
							"todo",
							"artifact_reference",
						].map((k) => (
							<option key={k} value={k}>
								{display(k)}
							</option>
						))}
					</select>
				</label>
				<label>
					{L("内容")}
					<textarea
						aria-label="记忆内容"
						className="pixel-input w-full"
						value={content}
						onChange={(e) => setContent(e.target.value)}
					/>
				</label>
				<fieldset>
					<legend>{L("允许的供应商（未选择表示所有已授权供应商）")}</legend>
					{providerList.map((p) => (
						<label className="mr-3" key={p.id}>
							<input
								type="checkbox"
								checked={providers.split(",").includes(p.id)}
								onChange={(e) =>
									setProviders(
										e.target.checked
											? [...providers.split(",").filter(Boolean), p.id].join(
													",",
												)
											: providers
													.split(",")
													.filter((id) => id !== p.id)
													.join(","),
									)
								}
							/>
							{p.name}
						</label>
					))}
				</fieldset>
				<fieldset>
					<legend>{L("与当前条目冲突的记忆")}</legend>
					{entries
						.filter((e) => e.id !== editing?.id)
						.map((e) => (
							<label className="block" key={e.id}>
								<input
									type="checkbox"
									checked={conflicts.split(",").includes(e.id)}
									onChange={(v) =>
										setConflicts(
											v.target.checked
												? [...conflicts.split(",").filter(Boolean), e.id].join(
														",",
													)
												: conflicts
														.split(",")
														.filter((id) => id !== e.id)
														.join(","),
										)
									}
								/>
								{e.content.slice(0, 100)}
							</label>
						))}
				</fieldset>
				<button
					className="pixel-button"
					disabled={!content.trim()}
					onClick={() =>
						void action(async () => {
							await api("/save", {
								id: editing?.id,
								version: editing?.version,
								entry: {
									...editing,
									kind,
									content,
									allowedProviders: providers
										.split(",")
										.map((x) => x.trim())
										.filter(Boolean),
									conflictsWith: conflicts
										.split(",")
										.map((x) => x.trim())
										.filter(Boolean),
								},
							});
							setContent("");
							setEditing(null);
							await refresh();
						})
					}
				>
					{L(editing ? "保存新版本" : "添加待确认记忆")}
				</button>
			</div>
			<details>
				<summary>{L("从已有消息或验收结果提出候选")}</summary>
				<select
					aria-label="来源类型"
					value={sourceKind}
					onChange={(e) => setSourceKind(e.target.value)}
				>
					<option value="message">{L("消息")}</option>
					<option value="task">{L("已验收任务")}</option>
				</select>
				<select
					className="pixel-input"
					aria-label="选择来源"
					value={source}
					onChange={(e) => setSource(e.target.value)}
				>
					<option value="">{L("选择来源")}</option>
					{(sourceKind === "message"
						? sources.messages.map((m) => ({ id: m.id, title: m.content }))
						: sources.tasks
					).map((x) => (
						<option key={x.id} value={x.id}>
							{x.title}
						</option>
					))}
				</select>
				<button
					className="pixel-button"
					onClick={() =>
						void action(async () => {
							await api(
								`/propose-${sourceKind}`,
								sourceKind === "message"
									? { messageId: source }
									: { rootTaskId: source },
							);
							await refresh();
						})
					}
				>
					{L("读取来源并提出候选")}
				</button>
			</details>
			<details>
				<summary>{L("任务读取的记忆")}</summary>
				<select
					className="pixel-input"
					aria-label="选择任务"
					value={root}
					onChange={(e) => setRoot(e.target.value)}
				>
					<option value="">{L("选择任务")}</option>
					{sources.tasks.map((t) => (
						<option key={t.id} value={t.id}>
							{t.title} · {t.status}
						</option>
					))}
				</select>
				<button
					className="pixel-button"
					onClick={() =>
						void action(async () =>
							setHistory(await api(`/tasks/${encodeURIComponent(root)}`)),
						)
					}
				>
					{L("查看冻结清单")}
				</button>
				<button
					className="pixel-button"
					onClick={() =>
						void action(async () =>
							setHistory(
								await api(`/tasks/${encodeURIComponent(root)}/refresh`, {}),
							),
						)
					}
				>
					{L("为重新规划创建新快照")}
				</button>
			</details>
			{!entries.length && <p>{L("没有匹配的项目记忆。")}</p>}
			<button
				className="pixel-button"
				disabled={!entries.some((e) => e.status === "proposed")}
				onClick={() =>
					void action(async () => {
						for (const e of entries.filter((e) => e.status === "proposed"))
							await save(e, "confirmed");
					})
				}
			>
				{L("批量确认候选")}
			</button>
			<button
				className="pixel-button"
				onClick={() =>
					void action(async () => {
						for (const e of entries.filter((e) => e.status === "proposed"))
							await save(e, "rejected");
					})
				}
			>
				{L("批量拒绝候选")}
			</button>
			{entries.map((e) => (
				<article className="border p-3 space-y-2" key={e.id}>
					<p>
						{display(e.kind)} · {display(e.status)} · v{e.version}{" "}
						{e.pinned ? "· 已固定" : ""}
					</p>
					<p className="whitespace-pre-wrap">{e.content}</p>

					{e.conflictsWith.length > 0 && (
						<p>
							{L("与当前条目冲突的记忆")}:{" "}
							{e.conflictsWith
								.map(
									(id) =>
										entries.find((x) => x.id === id)?.content.slice(0, 80) ??
										id,
								)
								.join("; ")}
						</p>
					)}
					<p>
						{L("来源")}: {display(e.origin)}{" "}
						{e.sourceRefs.join(", ") || L("无可携带来源")}
					</p>
					<div className="flex flex-wrap gap-2">
						<button
							className="pixel-button"
							onClick={() => {
								setEditing(e);
								setContent(e.content);
								setKind(e.kind);
								setProviders(e.allowedProviders.join(","));
								setConflicts(e.conflictsWith.join(","));
							}}
						>
							{L("编辑")}
						</button>
						<button
							className="pixel-button"
							onClick={() => void action(() => save(e, "confirmed"))}
						>
							{L("确认")}
						</button>
						<button
							className="pixel-button"
							onClick={() => void action(() => save(e, e.status, !e.pinned))}
						>
							{L(e.pinned ? "取消固定" : "固定")}
						</button>
						<button
							className="pixel-button"
							onClick={() => void action(() => save(e, "expired"))}
						>
							{L("停用")}
						</button>
						<button
							className="pixel-button"
							onClick={() =>
								void action(async () =>
									setHistory(await api(`/history/${e.id}`)),
								)
							}
						>
							{L("版本历史")}
						</button>
					</div>
				</article>
			))}
			{history !== null && (
				<details open>
					<summary>{L("版本记录")}</summary>
					<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
						{JSON.stringify(history, null, 2)}
					</pre>
				</details>
			)}
			<details>
				<summary>{L("导入 / 导出（先预览，再确认）")}</summary>
				<button
					className="pixel-button"
					onClick={() =>
						void action(async () => {
							setExchange(JSON.stringify(await api("/export"), null, 2));
							setPreview(null);
						})
					}
				>
					{L("生成 JSON 快照")}
				</button>
				<textarea
					aria-label="记忆交换 JSON"
					className="pixel-input w-full h-48"
					value={exchange}
					onChange={(e) => {
						setExchange(e.target.value);
						setPreview(null);
					}}
				/>
				<button
					className="pixel-button"
					onClick={() =>
						void action(async () =>
							setPreview(await api("/import-preview", JSON.parse(exchange))),
						)
					}
				>
					{L("预览导入")}
				</button>
				{preview !== null && (
					<>
						<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
							{JSON.stringify(preview, null, 2)}
						</pre>
						<button
							className="pixel-button"
							onClick={() =>
								void action(async () => {
									await api("/import", JSON.parse(exchange));
									setPreview(null);
									await refresh();
								})
							}
						>
							{L("将预览内容导入为候选")}
						</button>
					</>
				)}
			</details>
		</section>
	);
}
