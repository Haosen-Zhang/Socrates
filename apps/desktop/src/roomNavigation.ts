import type { AppMode, RoomMention } from "@socrates/core";

export type { RoomMention } from "@socrates/core";
export type SelectedMention = { label: string; mention: RoomMention };
export type RoomNavigation = {
  mode: AppMode;
  selected: Record<AppMode, string | null>;
};
export const initialRoomNavigation = (): RoomNavigation => ({
  mode: "chat",
  selected: { chat: null, cowork: null },
});
export function navigateRoom(
  nav: RoomNavigation,
  mode: AppMode,
  roomId: string,
): RoomNavigation {
  return { mode, selected: { ...nav.selected, [mode]: roomId } };
}
export function switchRoomMode(
  nav: RoomNavigation,
  mode: AppMode,
): RoomNavigation {
  return { ...nav, mode };
}
/** Suggestions require an active user prose token. No text is ever parsed into routing targets. */
export function roomMentionQuery(text: string): string | null {
  const line = text.slice(text.lastIndexOf("\n") + 1);
  if (
    /^\s*>/.test(line) ||
    (text.match(/^\s*```/gm)?.length ?? 0) % 2 !== 0 ||
    (line.match(/`/g)?.length ?? 0) % 2 !== 0
  )
    return null;
  return /(?:^|\s)@([^\s@]*)$/u.exec(text)?.[1] ?? null;
}
export function retainSelectedMentions(
  text: string,
  selected: SelectedMention[],
): SelectedMention[] {
  let fenced = false;
  const prose = text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return "";
      }
      if (fenced || /^\s*>/.test(line)) return "";
      return line.replace(/(`+).*?\1/g, " ");
    })
    .join("\n");
  return selected.filter((item) => {
    const escaped = item.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
      "u",
    ).test(prose);
  });
}
