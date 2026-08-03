import { useShallow } from "zustand/react/shallow";
import { useStore, type Store } from "./store";

/**
 * 订阅边界（P0.1）：组件只订阅自己声明的 store 字段。
 *
 * 机制链（selectors.test.ts 逐环验证）：
 * 1. `pick` 只读取声明的 key（构造上保证，Proxy 追踪测试验证）；
 * 2. `useShallow` 对输出做浅比较——未声明字段变化时输出 shallow-equal ⇒ 组件不重渲染；
 * 3. 受保护组件的 key 列表在此集中声明，测试断言它们与高频字段零交集。
 *
 * 结论：流式 delta / agent 事件 / 多 agent 轮询更新不再重渲染设置、供应商、MCP、侧栏等无关组件。
 */
export function pick<K extends keyof Store>(...keys: K[]) {
  return (state: Store): Pick<Store, K> => {
    const out = {} as Pick<Store, K>;
    for (const key of keys) out[key] = state[key];
    return out;
  };
}

/** 组件端唯一入口：浅比较的字段级订阅。 */
export function useStorePick<K extends keyof Store>(...keys: K[]): Pick<Store, K> {
  return useStore(useShallow(pick(...keys)));
}

/** 每帧/每事件级更新的字段。受保护组件的 key 列表不得包含它们（有测试把关）。 */
export const HIGH_FREQUENCY_KEYS = [
  "streaming",
  "messages",
  "sessionMessages",
  "agentEvents",
  "currentMultiTask",
  "usageSummaries",
] as const satisfies readonly (keyof Store)[];

// —— 受保护组件的订阅清单（与调用点一一对应，改一处必须同步改另一处） ——
export const APP_KEYS = ["status", "config", "connect"] as const;
export const SETTINGS_GENERAL_KEYS = ["config", "lang", "setLang", "updateConfig"] as const;
export const SETTINGS_CONFIG_KEYS = ["config", "updateConfig"] as const;
export const PROVIDER_CARD_KEYS = [
  "agents",
  "testResults",
  "modelLists",
  "testProvider",
  "removeProvider",
  "loadModels",
] as const;
export const PROVIDERS_PAGE_KEYS = ["providers", "saveProvider"] as const;
export const AGENTS_SECTION_KEYS = [
  "agents",
  "providers",
  "modelLists",
  "loadModels",
  "modelContextWindows",
  "loadModelContextWindow",
  "saveAgent",
  "removeAgent",
] as const;
export const WORKSPACE_CHIP_KEYS = [
  "activeWorkspace",
  "workspaces",
  "selectWorkspacePath",
  "setActiveWorkspace",
  "activeTaskId",
  "agentRunning",
] as const;
export const ATTACHMENT_TRAY_KEYS = [
  "activeWorkspace",
  "workspaces",
  "sessions",
  "currentSessionId",
  "draftAttachments",
  "draftWorkspaceRefs",
  "importWorkspaceAttachment",
  "importClipboardAttachment",
  "removeDraftAttachment",
  "removeDraftWorkspaceRef",
] as const;
export const MCP_SETTINGS_KEYS = [
  "mcpServers",
  "mcpTools",
  "activeWorkspace",
  "loadMcpServers",
  "saveMcpServer",
  "setMcpEnabled",
  "testMcpServer",
  "removeMcpServer",
  "loadMcpTools",
  "setMcpToolPolicy",
] as const;

export const GUARDED_KEY_LISTS: Record<string, readonly (keyof Store)[]> = {
  APP_KEYS,
  SETTINGS_GENERAL_KEYS,
  SETTINGS_CONFIG_KEYS,
  PROVIDER_CARD_KEYS,
  PROVIDERS_PAGE_KEYS,
  AGENTS_SECTION_KEYS,
  WORKSPACE_CHIP_KEYS,
  ATTACHMENT_TRAY_KEYS,
  MCP_SETTINGS_KEYS,
};
