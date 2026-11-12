import { useStore } from "../store";
export const arenaLabels: Record<string, [string, string]> = {
 "请先在来源房间授权所有成员": ["Authorize all members in the source room first","請先在來源房間授權所有成員"],
 "Squad 模板候选（可选）": ["Squad template candidates (optional)","Squad 模板候選（可選）"],
 "选择模板时使用冻结 Leader、成员、指令和策略；每个 trial 复制到独立工作区，不并行修改当前项目。": ["Templates freeze the Leader, roster, instructions and policy. Each trial uses an isolated workspace and cannot modify the current project concurrently.","模板凍結 Leader、成員、指令與策略；每個 trial 使用獨立工作區。"],
 arena_admission_disabled: ["New Arena experiments are disabled. Existing experiments can still resume.", "新 Arena 實驗已停用；已有實驗仍可恢復。"],
	计划样本: ["Planned samples", "計畫樣本"],
	已开始: ["Started", "已開始"],
	已结束样本: ["Terminal samples", "已結束樣本"],
	通过验收: ["Verified successes", "通過驗收"],
	"验证成功率（全部计划样本）": [
		"Verified success rate (all planned samples)",
		"驗證成功率（全部計畫樣本）",
	],
	未知: ["Unknown", "未知"],
	时间分解: ["Timing breakdown", "時間分解"],
	总耗时: ["Wall time", "總耗時"],
	排队: ["Queue", "排隊"],
	模型请求周期: ["Model request lifecycle", "模型請求週期"],
	工具执行: ["Tool execution", "工具執行"],
	验收执行: ["Verification", "驗收執行"],
	等待人工: ["Waiting for human", "等待人工"],
	人工实际操作时间: ["Human active time", "人工實際操作時間"],
	人工介入次数: ["Human interventions", "人工介入次數"],
	"阶段时间可能重叠，不能相加；人工实际操作时间未测量。": [
		"Stage intervals may overlap and cannot be added. Human active time is not measured.",
		"階段時間可能重疊，不能相加；人工實際操作時間未測量。",
	],
	任务类别: ["Task category", "任務類別"],
	全部类别: ["All categories", "全部類別"],
	原始样本结果: ["Raw sample results", "原始樣本結果"],
	"以下结果按所选任务类别筛选；重复运行不增加独立任务数。": [
		"Results below use the selected task category. Repeated runs do not increase the independent task count.",
		"以下結果按所選任務類別篩選；重複執行不增加獨立任務數。",
	],
	独立任务数: ["Independent tasks", "獨立任務數"],
	次运行: ["", "次執行"],
	已计价费用: ["Priced cost", "已計價費用"],
	估算费用: ["Estimated cost", "估算費用"],
	未定费用次数: ["Unknown-cost calls", "未定費用次數"],
	"下载 CSV": ["Download CSV", "下載 CSV"],
	"下载 JSONL": ["Download JSONL", "下載 JSONL"],
	等待连接: ["Waiting for connection", "等待連接"],
	主要成员直接执行: ["Primary member executes", "主要成員直接執行"],
	对照成员直接执行: ["Comparison member executes", "對照成員直接執行"],
	"规划 + 对照成员执行": ["Plan + comparison member", "規劃 + 對照成員執行"],
	"规划 + 执行 + 独立审核": [
		"Plan + execute + independent review",
		"規劃 + 執行 + 獨立審核",
	],
	"策略实验 Arena": ["Strategy experiments · Arena", "策略實驗 Arena"],
	"相同任务、相同起始文件，四组独立工作区。结果只表示本次样本，不自动修改项目或策略。":
		[
			"The same task and starting files in four isolated workspaces. Results describe these samples; they do not automatically change your project or policy.",
			"相同任務、相同起始文件，四組獨立工作區。結果只表示本次樣本，不自動修改項目或策略。",
		],
	新建实验: ["New experiment", "新建實驗"],
	"仅复制下面明确选择的文件；凭证、目录和链接不允许复制。所有组使用同一独立文件断言。":
		[
			"Only explicitly selected files are copied. Credentials, directories and links are excluded. Every variant uses the same independent file check.",
			"僅複製下面明確選擇的文件；憑證、目錄和鏈接不允許複製。所有組使用同一獨立文件斷言。",
		],
	主要成员: ["Primary member", "主要成員"],
	对照成员: ["Comparison member", "對照成員"],
	独立审核成员: ["Independent reviewer", "獨立審核成員"],
	选择成员: ["Choose member", "選擇成員"],
	任务: ["Task", "任務"],
	实验任务: ["Experiment task", "實驗任務"],
	"起始文件（每行一个相对路径）": [
		"Starting files (one relative path per line)",
		"起始文件（每行一個相對路徑）",
	],
	起始文件: ["Starting files", "起始文件"],
	验收文件: ["File to verify", "驗收文件"],
	必须包含: ["Required content", "必須包含"],
	"预算按调用前预留约束后续请求；无法保证供应商最终账单绝不超出，未知用量单列。":
		[
			"Reservations limit subsequent requests. Provider bills may differ; unknown usage is shown separately.",
			"預算按調用前預留約束後續請求；無法保證供應商最終帳單絕不超出，未知用量單列。",
		],
	"实验总预算 USD": ["Total experiment budget · USD", "實驗總預算 USD"],
	确认复制所选文件并冻结上述统一验收条件: [
		"Confirm copying the selected files and freezing these shared checks",
		"確認複製所選文件並凍結上述統一驗收條件",
	],
	"允许使用已配置模型，在总预算内产生实际 API 费用": [
		"Authorize configured models and real API charges within this total budget",
		"允許使用已配置模型，在總預算內產生實際 API 費用",
	],
	预算格式无效: ["Invalid budget format", "預算格式無效"],
	独立文件断言: ["Independent file check", "獨立文件斷言"],
	预检与冻结实验: ["Preflight and freeze experiment", "預檢與凍結實驗"],
	模拟模型测试: ["Simulated model test", "模擬模型測試"],
	真实模型实验: ["Live model experiment", "真實模型實驗"],
	"预估合计：": ["Estimated total: ", "預估合計："],
	存在不可报价样本: ["Some samples cannot be quoted", "存在不可報價樣本"],
	"· 总预算 $": [" · Total budget $", "· 總預算 $"],
	待开始: ["Ready to start", "待開始"],
	运行中: ["Running", "運行中"],
	等待处理: ["Waiting for action", "等待處理"],
	已结束: ["Finished", "已結束"],
	已取消: ["Cancelled", "已取消"],
	"· 已验证": [" · Verified ", "· 已驗證"],
	"· 已计价 $": [" · Priced $", "· 已計價 $"],
	"USD · 估算 $": [" USD · Estimated $", "USD · 估算 $"],
	"USD · 未定": [" USD · Unknown ", "USD · 未定"],
	"每个验证成功费用：": ["Cost per verified success: ", "每個驗證成功費用："],
	不可计算: ["Not calculable", "不可計算"],
	"· 样本未完成，不能形成正式组间结论": [
		" · Incomplete samples; no formal comparison yet",
		"· 樣本未完成，不能形成正式組間結論",
	],
	开始未运行样本: ["Start remaining samples", "開始未運行樣本"],
	停止实验: ["Stop experiment", "停止實驗"],
	预览配置和结果: ["Preview configuration and results", "預覽配置和結果"],
	未运行: ["Not started", "未運行"],
	已中断: ["Interrupted", "已中斷"],
	已完成: ["Completed", "已完成"],
	失败: ["Failed", "失敗"],
	尚未验收: ["Not verified yet", "尚未驗收"],
	"查看执行、审批与证据": [
		"Open execution, approvals and evidence",
		"查看執行、審批與證據",
	],
	停止此样本: ["Stop this sample", "停止此樣本"],
	"产物已清理；验证与费用历史仍保留。": [
		"Artifacts were removed; verification and cost history remain.",
		"產物已清理；驗證與費用歷史仍保留。",
	],
	"隔离产物保留在本机，可在结束后清理。": [
		"Isolated artifacts remain locally and can be removed when finished.",
		"隔離產物保留在本機，可在結束後清理。",
	],
	清理实验产物: ["Remove experiment artifacts", "清理實驗產物"],
	"仅删除本实验的隔离工作区和起始文件副本，不能撤销；原项目与费用账本保留。": [
		"Permanently remove only this experiment's isolated workspaces and starting copies. Your original project and cost ledger remain.",
		"僅刪除本實驗的隔離工作區和起始文件副本，不能撤銷；原項目與費用帳本保留。",
	],
	确认清理本实验产物: [
		"Confirm removing these artifacts",
		"確認清理本實驗產物",
	],
	"导出预览（不包含完整文件产物）": [
		"Export preview (full file artifacts excluded)",
		"匯出預覽（不包含完整文件產物）",
	],
	"下载 JSON": ["Download JSON", "下載 JSON"],
	关闭预览: ["Close preview", "關閉預覽"],
	查看差异与策略建议: [
		"File differences and strategy proposals",
		"查看差異與策略建議",
	],
	"查看不会改动项目。应用文件或策略前需明确确认；有冲突时停止。": [
		"Previewing does not change your project. Applying files or a strategy requires confirmation and stops on conflicts.",
		"查看不會改動項目。應用文件或策略前需明確確認；有衝突時停止。",
	],
	第: [" run ", "第"],
	"次 · 文件差异": [" · File diff", "次 · 文件差異"],
	实验产物差异: ["Experiment artifact diff", "實驗產物差異"],
	"· 当前项目已变化，不能应用": [
		" · Project changed; cannot apply",
		"· 當前項目已變化，不能應用",
	],
	"差异过长，预览已截断。": [
		"This long diff has been truncated.",
		"差異過長，預覽已截斷。",
	],
	确认将所选文件应用到原项目: [
		"Confirm applying selected files to the original project",
		"確認將所選文件應用到原項目",
	],
	应用所选产物: ["Apply selected artifacts", "應用所選產物"],
	"· 预览策略建议": [" · Preview strategy proposal", "· 預覽策略建議"],
	策略建议预览: ["Strategy proposal preview", "策略建議預覽"],
	"模拟结果，仅用于演示配置；不能证明模型优劣。": [
		"Simulated results demonstrate configuration only, not model quality.",
		"模擬結果，僅用於演示配置；不能證明模型優劣。",
	],
	"仅限当前样本和版本，不表示普遍最优。": [
		"Evidence applies only to these samples and versions, not general superiority.",
		"僅限當前樣本和版本，不表示普遍最優。",
	],
	确认更新原房间的后续任务策略: [
		"Confirm updating the source room's strategy for future tasks",
		"確認更新原房間的後續任務策略",
	],
	应用策略版本: ["Apply strategy version", "應用策略版本"],
	查看策略版本历史: ["View strategy history", "查看策略版本歷史"],
	策略版本: ["Strategy version ", "策略版本"],
	恢复此版本: ["Restore this version", "恢復此版本"],
	操作已完成: ["Action completed", "操作已完成"],
	"正在处理…": ["Working…", "正在處理…"],
	verified_success: ["Verified success", "通過驗收"],
	completed_unverified: ["Completed without verification", "完成但未驗收"],
	verification_failed: ["Verification failed", "驗收失敗"],
	blocked: ["Blocked", "已阻擋"],
	failed: ["Failed", "失敗"],
	cancelled: ["Cancelled", "已取消"],
	arena_strategy_insufficient_tasks: [
		"At least three distinct tasks are required; repeated runs do not count as new tasks.",
		"至少需要三個不同任務；重複執行不算新任務。",
	],
	arena_strategy_incomplete: [
		"Finish the planned experiment coverage before adopting a strategy.",
		"完成預定實驗範圍後才能採用策略。",
	],
	arena_strategy_unknown_cost: [
		"Resolve unknown costs before adopting this strategy.",
		"採用策略前請先處理未確定費用。",
	],
	arena_strategy_no_verified_success: [
		"This variant has no verified success to support adoption.",
		"此策略尚無通過驗收的結果。",
	],
	arena_strategy_config_changed: [
		"Room settings changed; create a new preview before applying or restoring.",
		"房間設定已變更；套用或還原前請重新預覽。",
	],
	arena_strategy_profile_changed: [
		"Member configuration changed since the experiment; rerun the experiment.",
		"成員設定已變更；請重新執行實驗。",
	],
	arena_strategy_preview_stale: [
		"The preview is out of date. Preview the strategy again.",
		"預覽已過期，請重新預覽策略。",
	],
	arena_strategy_member_revoked: [
		"A required member is no longer authorized. Review room members.",
		"必要成員已無授權，請檢查房間成員。",
	],
};
const arenaChinese: Record<string, string> = {
 arena_admission_disabled: "新 Arena 实验已停用；已有实验仍可恢复。",
	verified_success: "通过验收",
	completed_unverified: "已完成但未验收",
	verification_failed: "验收失败",
	blocked: "已阻挡",
	failed: "失败",
	cancelled: "已取消",
	arena_strategy_insufficient_tasks:
		"至少需要三个不同任务；重复运行不算新任务。",
	arena_strategy_incomplete: "请先完成预定实验范围，再采用策略。",
	arena_strategy_unknown_cost: "请先处理未确定费用，再采用策略。",
	arena_strategy_no_verified_success: "此策略尚无通过验收的结果。",
	arena_strategy_config_changed: "房间设置已变化；应用或恢复前请重新预览。",
	arena_strategy_profile_changed: "成员配置已变化，请重新运行实验。",
	arena_strategy_preview_stale: "预览已过期，请重新预览。",
	arena_strategy_member_revoked: "必要成员不再获授权，请检查房间成员。",
};
export function useArenaText() {
	const lang = useStore((s) => s.lang);
	return (value: string) => {
		const key = value.replace(/^Error: /, "");
		const entry = arenaLabels[key];
		return lang === "en"
			? (entry?.[0] ?? key)
			: lang === "zh-TW"
				? (entry?.[1] ?? key)
				: (arenaChinese[key] ?? key);
	};
}
export const arenaStyles = `.arena-panel{min-width:0;overflow-wrap:anywhere}.arena-panel article,.arena-panel section,.arena-panel details{min-width:0;max-width:100%}.arena-panel summary{cursor:pointer;font-weight:600;padding:.65rem 0}.arena-panel label{display:block;margin:.65rem 0}.arena-panel label:has(input[type=checkbox]){display:flex;gap:.6rem;align-items:flex-start}.arena-panel input:not([type=checkbox]),.arena-panel select,.arena-panel textarea{display:block;max-width:100%;width:100%;margin-top:.3rem}.arena-panel input[type=checkbox]{flex-shrink:0;margin-top:.2rem;width:auto}.arena-panel button{margin:.25rem;max-width:100%;white-space:normal}.arena-panel li{border-top:1px solid var(--pixel-border,#888);padding:.7rem 0;list-style:none}.arena-panel pre{max-width:100%;overflow:auto;overflow-wrap:anywhere}.arena-panel p[role=alert]{border:1px solid currentColor;padding:.65rem}.arena-panel h3,.arena-panel h4{font-weight:700}.arena-timing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.5rem}.arena-timing-grid dd{font-variant-numeric:tabular-nums}.arena-panel [data-testid=arena-raw-results]>section{margin:.8rem 0;border-top:1px solid var(--pixel-border,#888);padding-top:.5rem}.arena-panel [data-testid=arena-raw-results]{max-height:70vh;overflow:auto}.arena-panel fieldset{min-width:0}.arena-panel details>div{max-height:65vh;overflow-y:auto;padding-right:.4rem}`;
