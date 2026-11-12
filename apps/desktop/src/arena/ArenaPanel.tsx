import { useArenaText, arenaStyles } from "./strings";
import ArenaEvidenceActions from "./ArenaEvidenceActions";
import { useStore } from "../store";
import { useEffect, useState } from "react";
import type {
	ArenaDefinition,
	ArenaExperiment,
	ArenaVariant,
} from "../../../../packages/core/src/arena";
import { arenaMetrics } from "../../../../packages/core/src/arena";
import {
	atomicToDecimal,
	decimalToAtomic,
	type RoomCollaborationSettings,
} from "@socrates/core";
import { sidecarFetch, requireOk, type Handshake } from "../transport";
type ArenaTiming = {
	trialId: string;
	wallMs: number | null;
	queueMs: number | null;
	modelRequestLifecycleMs: number | null;
	toolMs: number | null;
	verificationMs: number | null;
	waitingHumanMs: number | null;
	humanInterventions: number;
	humanActiveMs: number | null;
};
type ArenaResult = ArenaExperiment & { timing?: ArenaTiming[] };

function SampleCounts({ trials }: { trials: ArenaExperiment["trials"] }) {
	const tr = useArenaText(),
		metrics = arenaMetrics(trials);
	return (
		<p data-testid="arena-sample-counts">
			{tr("计划样本")} {metrics.planned} · {tr("已开始")} {metrics.started} ·{" "}
			{tr("已结束样本")} {metrics.terminal} · {tr("通过验收")}{" "}
			{metrics.verified} · {tr("验证成功率（全部计划样本）")}{" "}
			{metrics.verifiedSuccessRate === null
				? tr("未知")
				: `${(metrics.verifiedSuccessRate * 100).toFixed(1)}%`}
		</p>
	);
}
function TimingBreakdown({ timing }: { timing?: ArenaTiming }) {
	const tr = useArenaText();
	const duration = (n: number | null | undefined) =>
		n === null || n === undefined ? tr("未知") : `${(n / 1000).toFixed(3)} s`;
	return (
		<details data-testid="arena-timing">
			<summary>{tr("时间分解")}</summary>
			<dl className="arena-timing-grid">
				{(
					[
						["总耗时", timing?.wallMs],
						["排队", timing?.queueMs],
						["模型请求周期", timing?.modelRequestLifecycleMs],
						["工具执行", timing?.toolMs],
						["验收执行", timing?.verificationMs],
						["等待人工", timing?.waitingHumanMs],
						["人工实际操作时间", timing?.humanActiveMs],
					] as const
				).map(([label, value]) => (
					<div key={label}>
						<dt>{tr(label)}</dt>
						<dd>{duration(value)}</dd>
					</div>
				))}
				<div>
					<dt>{tr("人工介入次数")}</dt>
					<dd>{timing?.humanInterventions ?? tr("未知")}</dd>
				</div>
			</dl>
			<p>{tr("阶段时间可能重叠，不能相加；人工实际操作时间未测量。")}</p>
		</details>
	);
}
export default function ArenaPanel({
	roomId,
	handshake,
}: {
	roomId: string;
	handshake: Handshake | null;
}) {
	const tr = useArenaText();
	const [experiments, setExperiments] = useState<ArenaResult[]>([]),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[notice, setNotice] = useState(""),
		[category, setCategory] = useState("");
	const [template, setTemplate] = useState<{
		members: { id: string; label: string }[];
		collaboration: RoomCollaborationSettings;
		controlledAvailable: boolean;
        squads:Array<import("@socrates/core").SquadTemplate & {arenaEligible:boolean}>;
	} | null>(null);
	const [selectedSquads,setSelectedSquads]=useState<string[]>([]);
	const [primary, setPrimary] = useState(""),
		[worker, setWorker] = useState(""),
		[reviewer, setReviewer] = useState("");
	const [prompt, setPrompt] = useState(""),
		[files, setFiles] = useState(""),
		[target, setTarget] = useState("result.txt"),
		[expected, setExpected] = useState(""),
		[budget, setBudget] = useState("1"),
		[ack, setAck] = useState(false),
		[live, setLive] = useState(false),
		[preview, setPreview] = useState<ArenaExperiment | null>(null);
	const request = async <T,>(path: string, body?: unknown): Promise<T> => {
		if (!handshake) throw new Error(tr("等待连接"));
		return requireOk<T>(
			await sidecarFetch(
				handshake,
				`/arena${path}`,
				body === undefined
					? undefined
					: {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(body),
						},
			),
		);
	};
	const refresh = async () => {
		setExperiments(await request<ArenaResult[]>(`/rooms/${roomId}`));
	};
	useEffect(() => {
		let stale = false;
		setExperiments([]);
		setCategory("");
        setSelectedSquads([]);
		setError("");
		request<typeof template>(`/rooms/${roomId}/templates`)
			.then((t) => {
				if (stale || !t) return;
				setTemplate(t);
				setPrimary(t.members[0]?.id ?? "");
				setWorker(t.members[1]?.id ?? "");
				setReviewer(t.members[2]?.id ?? "");
			})
			.catch((e) => !stale && setError(String(e)));
		const poll = () =>
			request<ArenaResult[]>(`/rooms/${roomId}`)
				.then((x) => !stale && setExperiments(x))
				.catch((e) => !stale && setError(String(e)));
		void poll();
		const timer = setInterval(poll, 1500);
		return () => {
			stale = true;
			clearInterval(timer);
		};
	}, [roomId, handshake]);
	const action = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await fn();
			await refresh();
			setNotice(tr("操作已完成"));
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};
	const download = async (experimentId: string, format: "csv" | "jsonl") => {
		if (!handshake) throw new Error(tr("等待连接"));
		const response = await sidecarFetch(
			handshake,
			`/arena/experiments/${experimentId}/export.${format}`,
		);
		if (!response.ok) {
			await requireOk(response);
			return;
		}
		const blob = new Blob([await response.text()], {
			type:
				format === "csv" ? "text/csv;charset=utf-8" : "application/x-ndjson",
		});
		const url = URL.createObjectURL(blob),
			anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `arena-results.${format}`;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	const variants = (): ArenaVariant[] => selectedSquads.length ? template!.squads.filter(s=>selectedSquads.includes(s.id)).map(s=>({id:s.id,label:s.name,primaryAgentId:s.leaderAgentId,collaboration:template!.collaboration,squadId:s.id,squadRevision:s.revision})) :
        ["A", "B", "C", "D"].map((id, index) => {
			const collaboration = structuredClone(template!.collaboration);
			collaboration.discussion.enabled = false;
			collaboration.assignment.routing.mode = "manual";
			collaboration.assignment.routing.lightweightAgentId = index
				? worker
				: primary;
			collaboration.assignment.routing.complexAgentId = index
				? worker
				: primary;
			collaboration.assignment.routing.criticalAgentId = index
				? worker
				: primary;
			collaboration.assignment.coordinatorAgentId = primary;
			collaboration.assignment.callableAgentIds = [
				...new Set([primary, worker, ...(index === 3 ? [reviewer] : [])]),
			];
			collaboration.strategy = index < 2 ? "single" : "team";
			collaboration.planConfirmation.reviewerAgentId =
				index === 3 ? reviewer : null;
			return {
				id,
				label: [
					tr("主要成员直接执行"),
					tr("对照成员直接执行"),
					tr("规划 + 对照成员执行"),
					tr("规划 + 执行 + 独立审核"),
				][index]!,
				primaryAgentId: index ? worker : primary,
				collaboration,
			};
		});
	return (
		<section aria-label="Arena" className="arena-panel space-y-3 p-4">
			<style>{arenaStyles}</style>
			<h2 className="text-lg font-bold">{tr("策略实验 Arena")}</h2>
			<p>
				{tr(
					"相同任务、相同起始文件，四组独立工作区。结果只表示本次样本，不自动修改项目或策略。",
				)}
			</p>
			{error && <p role="alert">{tr(error)}</p>}
			<p role="status" aria-live="polite">
				{busy ? tr("正在处理…") : notice}
			</p>
			<details>
				<summary>{tr("新建实验")}</summary>
                <fieldset className="space-y-2"><legend>{tr("Squad 模板候选（可选）")}</legend>{template?.squads.map(s=><label key={s.id} className="flex gap-2"><input type="checkbox" checked={selectedSquads.includes(s.id)} disabled={busy||!s.arenaEligible||!selectedSquads.includes(s.id)&&selectedSquads.length>=5} onChange={e=>{setSelectedSquads(e.target.checked?[...selectedSquads,s.id]:selectedSquads.filter(id=>id!==s.id));setPreview(null);}}/>{s.name} · v{s.revision}{!s.arenaEligible?` · ${tr("请先在来源房间授权所有成员")}`:""}</label>)}<p>{tr("选择模板时使用冻结 Leader、成员、指令和策略；每个 trial 复制到独立工作区，不并行修改当前项目。")}</p></fieldset>
				<div className="space-y-2">
					<p>
						{tr(
							"仅复制下面明确选择的文件；凭证、目录和链接不允许复制。所有组使用同一独立文件断言。",
						)}
					</p>
					{(
						[
							[tr("主要成员"), primary, setPrimary],
							[tr("对照成员"), worker, setWorker],
							[tr("独立审核成员"), reviewer, setReviewer],
						] as const
					).map(([label, value, setter]) => (
						<label key={label}>
							{label}
							<select
								className="pixel-input p-2"
								aria-label={label}
								value={value}
								onChange={(e) => setter(e.target.value)}
							>
								<option value="">{tr("选择成员")}</option>
								{template?.members.map((m) => (
									<option key={m.id} value={m.id}>
										{m.label}
									</option>
								))}
							</select>
						</label>
					))}
					<label>
						{tr("任务")}
						<textarea
							className="pixel-input w-full min-h-24 p-2"
							aria-label={tr("实验任务")}
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
						/>
					</label>
					<label>
						{tr("起始文件（每行一个相对路径）")}
						<textarea
							className="pixel-input w-full min-h-24 p-2"
							aria-label={tr("起始文件")}
							value={files}
							onChange={(e) => setFiles(e.target.value)}
						/>
					</label>
					<label>
						{tr("验收文件")}
						<input
							className="pixel-input p-2"
							value={target}
							onChange={(e) => setTarget(e.target.value)}
						/>
					</label>
					<label>
						{tr("必须包含")}
						<input
							className="pixel-input p-2"
							value={expected}
							onChange={(e) => setExpected(e.target.value)}
						/>
					</label>
					<p>
						{tr(
							"预算按调用前预留约束后续请求；无法保证供应商最终账单绝不超出，未知用量单列。",
						)}
					</p>
					<label>
						{tr("实验总预算 USD")}
						<input
							className="pixel-input p-2"
							value={budget}
							onChange={(e) => setBudget(e.target.value)}
							inputMode="decimal"
						/>
					</label>
					<label>
						<input
							className="pixel-input p-2"
							type="checkbox"
							checked={ack}
							onChange={(e) => setAck(e.target.checked)}
						/>
						{tr("确认复制所选文件并冻结上述统一验收条件")}
					</label>
					{!template?.controlledAvailable && (
						<label>
							<input
								className="pixel-input p-2"
								type="checkbox"
								checked={live}
								onChange={(e) => setLive(e.target.checked)}
							/>
							{tr("允许使用已配置模型，在总预算内产生实际 API 费用")}
						</label>
					)}
					<button
						className="pixel-button px-3 py-2"
						disabled={
							busy ||
							!ack ||
							!prompt ||
							(!selectedSquads.length && (!primary || !worker || !reviewer || reviewer === worker)) ||
							(!template?.controlledAvailable && !live)
						}
						onClick={() =>
							void action(async () => {
								if (!/^\d+(\.\d{1,9})?$/.test(budget))
									throw new Error(tr("预算格式无效"));
								const limit = decimalToAtomic(budget);
								const body: ArenaDefinition = {
									schemaVersion: 1,
									roomId,
									requestId: crypto.randomUUID(),
									label: prompt.slice(0, 60),
									datasetVersion: "user-v1",
									files: files
										.split("\n")
										.map((s) => s.trim())
										.filter(Boolean),
									tasks: [
										{
											id: "task",
											category: "user",
											prompt,
											checks: [
												{
													id: "acceptance",
													label: tr("独立文件断言"),
													kind: "file",
													path: target,
													contains: expected,
													required: true,
													origin: "user",
												},
											],
											artifactPaths: [target],
											protectedPaths: [],
										},
									],
									variants: variants(),
									repeats: 1,
									concurrency: 1,
									timeoutMs: 600000,
									groupBudgetAtomic: limit,
									trialBudgetAtomic: limit,
									mode: template!.controlledAvailable ? "controlled" : "live",
									acknowledgeSnapshot: true,
									authorizeLive: live,
								};
								const prepared = await request<ArenaExperiment>(
									"/experiments",
									body,
								);
								setPreview(
									await request<ArenaExperiment>(
										`/experiments/${prepared.id}/export`,
									),
								);
							})
						}
					>
						{tr("预检与冻结实验")}
					</button>
				</div>
			</details>
			<label>
				{tr("任务类别")}
				<select
					className="pixel-input p-2"
					aria-label={tr("任务类别")}
					value={category}
					onChange={(event) => setCategory(event.target.value)}
				>
					<option value="">{tr("全部类别")}</option>
					{[
						...new Set(
							experiments.flatMap((e) =>
								e.definition.tasks.map((task) => task.category),
							),
						),
					].map((value) => (
						<option key={value} value={value}>
							{value}
						</option>
					))}
				</select>
			</label>
			{experiments.map((e) => {
				const metrics = arenaMetrics(e.trials);
				const tasks = e.definition.tasks.filter(
					(task) => !category || task.category === category,
				);
				const samples = e.trials.filter((trial) =>
					tasks.some((task) => task.id === trial.taskId),
				);
				return (
					<article className="border p-3" key={e.id}>
						<h3>
							{e.definition.label} ·{" "}
							{e.definition.mode === "controlled"
								? tr("模拟模型测试")
								: tr("真实模型实验")}
						</h3>
						<p>
							{tr("预估合计：")}
							{e.trials.every(
								(t) =>
									t.quote?.highAtomic !== null &&
									t.quote?.highAtomic !== undefined,
							)
								? `$${atomicToDecimal(e.trials.reduce((n, t) => n + BigInt(t.quote!.highAtomic!), 0n).toString())}`
								: tr("存在不可报价样本")}{" "}
							{tr("· 总预算 $")}
							{atomicToDecimal(e.definition.groupBudgetAtomic)}
						</p>
						<p>
							{
								{
									prepared: tr("待开始"),
									running: tr("运行中"),
									paused: tr("等待处理"),
									completed: tr("已结束"),
									cancelled: tr("已取消"),
								}[e.status]
							}{" "}
							{tr("· 已验证")}
							{metrics.verified}/{metrics.planned} {tr("· 已计价 $")}
							{atomicToDecimal(metrics.knownAtomic)} {tr("USD · 估算 $")}
							{atomicToDecimal(metrics.estimatedAtomic)} {tr("USD · 未定")}
							{metrics.unknownCount}
						</p>
						<p>
							{tr("每个验证成功费用：")}
							{metrics.costPerVerifiedSuccessAtomic
								? `$${atomicToDecimal(metrics.costPerVerifiedSuccessAtomic)}`
								: tr("不可计算")}
							{metrics.incomplete
								? tr("· 样本未完成，不能形成正式组间结论")
								: ""}
						</p>
						<SampleCounts trials={e.trials} />
						<details data-testid="arena-raw-results">
							<summary>{tr("原始样本结果")}</summary>
							<p>
								{tr("以下结果按所选任务类别筛选；重复运行不增加独立任务数。")}
							</p>
							<SampleCounts trials={samples} />
							<p>
								{tr("独立任务数")} {tasks.length}
							</p>
							{e.definition.variants.map((variant) => (
								<section key={variant.id}>
									<h4>{variant.label}</h4>
									<SampleCounts
										trials={samples.filter(
											(trial) => trial.variantId === variant.id,
										)}
									/>
								</section>
							))}
							{tasks.map((task) => (
								<section key={task.id}>
									<h4>
										{task.category} · {task.prompt}
									</h4>
									{e.definition.variants.map((variant) => (
										<div key={variant.id}>
											<strong>{variant.label}</strong>
											<SampleCounts
												trials={samples.filter(
													(trial) =>
														trial.taskId === task.id &&
														trial.variantId === variant.id,
												)}
											/>
										</div>
									))}
								</section>
							))}
						</details>
						<button
							className="pixel-button px-3 py-2"
							disabled={
								busy || e.status === "completed" || e.status === "cancelled"
							}
							onClick={() =>
								void action(() => request(`/experiments/${e.id}/start`, {}))
							}
						>
							{tr("开始未运行样本")}
						</button>
						<button
							className="pixel-button px-3 py-2"
							disabled={busy || ["completed", "cancelled"].includes(e.status)}
							onClick={() =>
								void action(() => request(`/experiments/${e.id}/cancel`, {}))
							}
						>
							{tr("停止实验")}
						</button>
						<button
							className="pixel-button px-3 py-2"
							onClick={() =>
								void action(async () =>
									setPreview(
										await request<ArenaExperiment>(
											`/experiments/${e.id}/export`,
										),
									),
								)
							}
						>
							{tr("预览配置和结果")}
						</button>
						<ul>
							{samples.map((t) => (
								<li key={t.id} data-arena-variant={t.variantId}>
									<p>
										{
											e.definition.tasks.find((task) => task.id === t.taskId)
												?.prompt
										}{" "}
										·{" "}
										{
											e.definition.tasks.find((task) => task.id === t.taskId)
												?.category
										}
									</p>
									{e.definition.variants.find(
										(variant) => variant.id === t.variantId,
									)?.label ?? t.variantId}{" "}
									· {tr("第")}
									{t.repeat + 1}
									{tr("次运行")} ·{" "}
									{
										{
											planned: tr("未运行"),
											running: tr("运行中"),
											waiting: tr("等待处理"),
											interrupted: tr("已中断"),
											completed: tr("已完成"),
											failed: tr("失败"),
											cancelled: tr("已取消"),
										}[t.status]
									}{" "}
									· {t.outcome ? tr(t.outcome) : tr("尚未验收")} {t.reason}
									<p>
										{tr("已计价费用")} ${atomicToDecimal(t.knownAtomic)} USD ·{" "}
										{tr("估算费用")} ${atomicToDecimal(t.estimatedAtomic)} USD ·{" "}
										{tr("未定费用次数")} {t.unknownCount}
									</p>
									<TimingBreakdown
										timing={e.timing?.find((timing) => timing.trialId === t.id)}
									/>
									<button
										className="pixel-button px-3 py-2"
										onClick={() =>
											void useStore
												.getState()
												.loadSessions()
												.then(() => useStore.getState().selectRoom(t.roomId))
										}
									>
										{tr("查看执行、审批与证据")}
									</button>
									<button
										className="pixel-button px-3 py-2"
										disabled={busy || ["completed", "failed", "cancelled"].includes(t.status)}
										onClick={() =>
											void action(() =>
												request(
													`/experiments/${e.id}/trials/${t.id}/cancel`,
													{},
												),
											)
										}
									>
										{tr("停止此样本")}
									</button>
								</li>
							))}
						</ul>
						<p>
							{e.artifactsExpiredAt
								? tr("产物已清理；验证与费用历史仍保留。")
								: tr("隔离产物保留在本机，可在结束后清理。")}
						</p>
						{!e.artifactsExpiredAt &&
							e.trials.every((t) =>
								["completed", "failed", "cancelled"].includes(t.status),
							) && (
								<details>
									<summary>{tr("清理实验产物")}</summary>
									<p>
										{tr(
											"仅删除本实验的隔离工作区和起始文件副本，不能撤销；原项目与费用账本保留。",
										)}
									</p>
									<button
										className="pixel-button px-3 py-2"
										disabled={busy}
										onClick={() =>
											void action(() =>
												request(`/experiments/${e.id}/cleanup`, {
													confirmed: true,
												}),
											)
										}
									>
										{tr("确认清理本实验产物")}
									</button>
								</details>
							)}
						<ArenaEvidenceActions
							experiment={e}
							handshake={handshake}
							onChanged={refresh}
						/>
					</article>
				);
			})}
			{preview && (
				<details open>
					<summary>{tr("导出预览（不包含完整文件产物）")}</summary>
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap">
						{JSON.stringify(preview, null, 2)}
					</pre>
					<button
						className="pixel-button px-3 py-2"
						onClick={() => {
							const blob = new Blob([JSON.stringify(preview, null, 2)], {
								type: "application/json",
							});
							const url = URL.createObjectURL(blob),
								a = document.createElement("a");
							a.href = url;
							a.download = "arena-results.json";
							a.click();
							URL.revokeObjectURL(url);
						}}
					>
						{tr("下载 JSON")}
					</button>
					{(["csv", "jsonl"] as const).map((format) => (
						<button
							key={format}
							className="pixel-button px-3 py-2"
							disabled={busy}
							onClick={() => void action(() => download(preview.id, format))}
						>
							{tr(format === "csv" ? "下载 CSV" : "下载 JSONL")}
						</button>
					))}
					<button
						className="pixel-button px-3 py-2"
						onClick={() => setPreview(null)}
					>
						{tr("关闭预览")}
					</button>
				</details>
			)}
		</section>
	);
}
