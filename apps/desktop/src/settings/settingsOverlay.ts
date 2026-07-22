/**
 * Settings overlay 状态机（C6，纯函数）。
 *
 * Settings 是 overlay 而不是 NavigationTarget：关闭后必须回到用户原本所在的房间，
 * 若把它当作 primary target 就会覆盖「用户原本在哪」。
 *
 * 单实例语义：重复触发（左下角按钮、⌘,、菜单项）只聚焦已打开的实例，
 * 不叠加第二个——这正是 `⌘,` 每次创建新窗口那类 bug 的防线。
 */
export type SettingsSection =
  | "general"
  | "providers"
  | "bots"
  | "mcp"
  | "skills"
  | "memory"
  | "network"
  | "appearance";

export type SettingsOverlayState = {
  open: boolean;
  section: SettingsSection;
  /** 每次「打开」请求递增；已打开时用它驱动重新聚焦，而不是新建实例 */
  focusNonce: number;
};

export const INITIAL_SETTINGS_OVERLAY: SettingsOverlayState = {
  open: false,
  section: "general",
  focusNonce: 0,
};

/** 打开（或聚焦已打开的）设置。返回新状态；永远只有一个实例。 */
export function openSettings(
  state: SettingsOverlayState,
  section?: SettingsSection,
): SettingsOverlayState {
  return {
    open: true,
    section: section ?? state.section,
    focusNonce: state.focusNonce + 1,
  };
}

/** 关闭设置，保留上次所在分区以便下次打开时回到原处。 */
export function closeSettings(state: SettingsOverlayState): SettingsOverlayState {
  return { ...state, open: false };
}

/** ⌘, / Ctrl+, 的判定（macOS 用 meta，其它平台用 ctrl）。 */
export function isSettingsShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return event.key === "," && (event.metaKey || event.ctrlKey);
}
