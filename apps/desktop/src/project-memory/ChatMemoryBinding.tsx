import { useEffect, useState } from "react";
import type { MemoryEntry } from "@socrates/core";
import { useStore } from "../store";
import { requireOk, sidecarFetch } from "../transport";
export function ChatMemoryBinding({ roomId }: { roomId: string }) {
	const handshake = useStore((s) => s.handshake),
		rooms = useStore((s) => s.sessions),
		lang = useStore((s) => s.lang);
	const en = lang === "en",
		tw = lang === "zh-TW";
	const label = (zh: string, enText: string, traditional: string) =>
		en ? enText : tw ? traditional : zh;
	const [source, setSource] = useState(""),
		[ids, setIds] = useState<string[]>([]),
		[entries, setEntries] = useState<MemoryEntry[]>([]),
		[message, setMessage] = useState("");
	const works = rooms.filter(
		(r) => r.kind === "cowork" && r.workspaceId && !r.archived,
	);
	async function api<T>(room: string, path: string, body?: unknown) {
		if (!handshake) throw Error("waiting_sidecar");
		return requireOk<T>(
			await sidecarFetch(
				handshake,
				`/project-memory/${encodeURIComponent(room)}${path}`,
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
	useEffect(() => {
		let live = true;
		setEntries([]);
		setIds([]);
		setSource("");
		void api<{ projectId: string | null; ids: string[] }>(roomId, "/binding")
			.then((v) => {
				if (live) {
					setSource(works.find((r) => r.workspaceId === v.projectId)?.id ?? "");
					setIds(v.ids);
				}
			})
			.catch((e) => {
				if (live) setMessage(String(e));
			});
		return () => {
			live = false;
		};
	}, [roomId, handshake]);
	useEffect(() => {
		let live = true;
		setEntries([]);
		if (source)
			void api<MemoryEntry[]>(source, "")
				.then((v) => {
					if (live)
						setEntries(
							v.filter((e) => !e.roomScope && e.status === "confirmed"),
						);
				})
				.catch((e) => {
					if (live) setMessage(String(e));
				});
		return () => {
			live = false;
		};
	}, [source, handshake]);
	return (
		<details className="p-2 text-sm">
			<summary>
				{label(
					"选择可共享的项目背景",
					"Shared project background",
					"選擇可共享的項目背景",
				)}
			</summary>
			<p>
				{label(
					"只分享勾选条目；不授予工作区工具权限。",
					"Only selected entries are shared; workspace tools remain unavailable.",
					"只分享勾選條目；不授予工作区工具權限。",
				)}
			</p>
			<label>
				{label("来源项目房间", "Source Work room", "來源項目房間")}
				<select
					className="pixel-input w-full"
					value={source}
					onChange={(e) => {
						setSource(e.target.value);
						setIds([]);
					}}
				>
					<option value="">
						{label("选择房间", "Choose room", "選擇房間")}
					</option>
					{works.map((r) => (
						<option key={r.id} value={r.id}>
							{r.title}
						</option>
					))}
				</select>
			</label>
			<div className="max-h-48 overflow-y-auto">
				{entries.map((e) => (
					<label className="flex gap-2 p-1" key={e.id}>
						<input
							type="checkbox"
							checked={ids.includes(e.id)}
							onChange={(v) =>
								setIds(
									v.target.checked
										? [...ids, e.id]
										: ids.filter((id) => id !== e.id),
								)
							}
						/>
						<span>{e.content}</span>
					</label>
				))}
			</div>
			{source && !entries.length && (
				<p>
					{label(
						"没有已确认的可共享条目",
						"No confirmed shareable entries",
						"沒有已確認的可共享條目",
					)}
				</p>
			)}
			<button
				className="pixel-button"
				disabled={!source}
				onClick={() =>
					void api(roomId, "/bind", { sourceRoomId: source, ids })
						.then(() =>
							setMessage(
								label(
									"已保存；新任务生效。",
									"Saved for new tasks.",
									"已保存；新任務生效。",
								),
							),
						)
						.catch((e) => setMessage(String(e)))
				}
			>
				{label("保存共享范围", "Save selection", "保存共享範圍")}
			</button>
			<button
				className="pixel-button"
				disabled={!source}
				onClick={() =>
					void api(roomId, "/bind", { sourceRoomId: source, ids: [] })
						.then(() => {
							setIds([]);
							setMessage(label("已撤销共享", "Sharing revoked", "已撤銷共享"));
						})
						.catch((e) => setMessage(String(e)))
				}
			>
				{label("撤销共享", "Revoke sharing", "撤銷共享")}
			</button>
			<p role="status">{message}</p>
		</details>
	);
}
