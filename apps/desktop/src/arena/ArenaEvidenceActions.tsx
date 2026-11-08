import { useArenaText } from "./strings";
import { useState } from "react";
import type { ArenaExperiment } from "../../../../packages/core/src/arena";
import { requireOk, sidecarFetch, type Handshake } from "../transport";
type Diff = {
	previewHash: string;
	files: Array<{
		path: string;
		conflict: boolean;
		diff: string;
		diffTruncated: boolean;
	}>;
	limitations: string[];
};
type Strategy = {
	hash: string;
	eligible: boolean;
	blockers: string[];
	warnings?: string[];
	interpretation: string;
	proposed: unknown;
};
export default function ArenaEvidenceActions({
	experiment,
	handshake,
	onChanged,
}: {
	experiment: ArenaExperiment;
	handshake: Handshake | null;
	onChanged: () => Promise<void>;
}) {
	const tr = useArenaText();
	const [diff, setDiff] = useState<Diff | null>(null),
		[trialId, setTrialId] = useState(""),
		[paths, setPaths] = useState<string[]>([]),
		[confirmArtifact, setConfirmArtifact] = useState(false),
		[confirmStrategy, setConfirmStrategy] = useState(false),
		[strategy, setStrategy] = useState<Strategy | null>(null),
		[history, setHistory] = useState<Array<{ id: string; version?: number }>>(
			[],
		),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false),
		[notice, setNotice] = useState("");
	async function request<T>(path: string, body?: unknown): Promise<T> {
		if (!handshake) throw new Error(tr("等待连接"));
		return requireOk<T>(
			await sidecarFetch(
				handshake,
				path,
				body === undefined
					? undefined
					: {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(body),
						},
			),
		);
	}
	async function action(fn: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await fn();
			await onChanged();
			setNotice(tr("操作已完成"));
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}
	return (
		<details>
			<summary>{tr("查看差异与策略建议")}</summary>
			{error && <p role="alert">{tr(error)}</p>}
			<p role="status" aria-live="polite">
				{busy ? tr("正在处理…") : notice}
			</p>
			<p>
				{tr("查看不会改动项目。应用文件或策略前需明确确认；有冲突时停止。")}
			</p>
			{experiment.trials.map((t) => (
				<button
					className="pixel-button px-3 py-2"
					key={t.id}
					disabled={
						busy || !["completed", "failed", "cancelled"].includes(t.status)
					}
					onClick={() =>
						void action(async () => {
							setTrialId(t.id);
							setPaths([]);
							setConfirmArtifact(false);
							setDiff(
								await request<Diff>("/arena-artifacts/preview", {
									experimentId: experiment.id,
									trialId: t.id,
								}),
							);
						})
					}
				>
					{t.variantId} {tr("第")}
					{t.repeat + 1} {tr("次 · 文件差异")}
				</button>
			))}
			{diff && (
				<section aria-label={tr("实验产物差异")}>
					<p>{diff.limitations.join("；")}</p>
					{diff.files.map((f) => (
						<div key={f.path}>
							<label>
								<input
									className="pixel-input p-2"
									type="checkbox"
									disabled={f.conflict || busy}
									checked={paths.includes(f.path)}
									onChange={(e) =>
										setPaths(
											e.target.checked
												? [...paths, f.path]
												: paths.filter((p) => p !== f.path),
										)
									}
								/>
								{f.path}
								{f.conflict ? tr("· 当前项目已变化，不能应用") : ""}
							</label>
							<pre className="max-h-64 overflow-auto whitespace-pre-wrap">
								{f.diff}
							</pre>
							{f.diffTruncated && <p>{tr("差异过长，预览已截断。")}</p>}
						</div>
					))}
					<label>
						<input
							className="pixel-input p-2"
							type="checkbox"
							checked={confirmArtifact}
							onChange={(e) => setConfirmArtifact(e.target.checked)}
						/>
						{tr("确认将所选文件应用到原项目")}
					</label>
					<button
						className="pixel-button px-3 py-2"
						disabled={busy || !confirmArtifact || !paths.length}
						onClick={() =>
							void action(async () => {
								await request("/arena-artifacts/apply", {
									experimentId: experiment.id,
									trialId,
									previewHash: diff.previewHash,
									paths,
									requestId: crypto.randomUUID(),
									confirmed: true,
								});
								setDiff(null);
								setConfirmArtifact(false);
							})
						}
					>
						{tr("应用所选产物")}
					</button>
				</section>
			)}
			{experiment.definition.variants.map((v) => (
				<button
					className="pixel-button px-3 py-2"
					key={v.id}
					disabled={busy}
					onClick={() =>
						void action(async () => {
							setStrategy(
								await request<Strategy>("/arena-strategy/preview", {
									experimentId: experiment.id,
									variantId: v.id,
								}),
							);
							setConfirmStrategy(false);
						})
					}
				>
					{v.label} {tr("· 预览策略建议")}
				</button>
			))}
			{strategy && (
				<section aria-label={tr("策略建议预览")}>
					<p>
						{strategy.interpretation === "demonstration_configuration"
							? tr("模拟结果，仅用于演示配置；不能证明模型优劣。")
							: tr("仅限当前样本和版本，不表示普遍最优。")}
					</p>
					{strategy.blockers.map((x) => (
						<p key={x}>{tr(x)}</p>
					))}
					{strategy.warnings?.map((x) => (
						<p key={x}>{x}</p>
					))}
					<pre className="max-h-64 overflow-auto whitespace-pre-wrap">
						{JSON.stringify(strategy.proposed, null, 2)}
					</pre>
					<label>
						<input
							className="pixel-input p-2"
							type="checkbox"
							checked={confirmStrategy}
							onChange={(e) => setConfirmStrategy(e.target.checked)}
						/>
						{tr("确认更新原房间的后续任务策略")}
					</label>
					<button
						className="pixel-button px-3 py-2"
						disabled={busy || !confirmStrategy || !strategy.eligible}
						onClick={() =>
							void action(async () => {
								await request(
									`/arena-strategy/rooms/${experiment.definition.roomId}/apply`,
									{
										previewHash: strategy.hash,
										requestId: crypto.randomUUID(),
										confirmed: true,
									},
								);
								setStrategy(null);
								setConfirmStrategy(false);
							})
						}
					>
						{tr("应用策略版本")}
					</button>
				</section>
			)}
			<button
				className="pixel-button px-3 py-2"
				disabled={busy}
				onClick={() =>
					void action(async () =>
						setHistory(
							await request(
								`/arena-strategy/rooms/${experiment.definition.roomId}/history`,
							),
						),
					)
				}
			>
				{tr("查看策略版本历史")}
			</button>
			{history.map((v, index) => (
				<div key={v.id}>
					<span>
						{tr("策略版本")}
						{v.version ?? history.length - index}
					</span>
					<button
						className="pixel-button px-3 py-2"
						disabled={busy}
						onClick={() =>
							void action(async () => {
								await request(
									`/arena-strategy/rooms/${experiment.definition.roomId}/rollback`,
									{ versionId: v.id, requestId: crypto.randomUUID() },
								);
								setHistory(
									await request(
										`/arena-strategy/rooms/${experiment.definition.roomId}/history`,
									),
								);
							})
						}
					>
						{tr("恢复此版本")}
					</button>
				</div>
			))}
		</details>
	);
}
