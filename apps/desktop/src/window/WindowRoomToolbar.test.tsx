import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import WindowRoomToolbar from "./WindowRoomToolbar";

describe("WindowRoomToolbar", () => {
  it("keeps the restore action outside a hidden sidebar", () => {
    const html = renderToStaticMarkup(
      <WindowRoomToolbar
        title="Nature 期刊讨论"
        subtitle="单 Agent · 空闲"
        sidebarHidden
        toolbarMode="macos-overlay"
        collapseLabel="收起侧栏"
        expandLabel="展开侧栏"
        onToggleSidebar={() => {}}
      >
        <button type="button">历史任务</button>
      </WindowRoomToolbar>,
    );

    expect(html).toContain("Nature 期刊讨论");
    expect(html).toContain("单 Agent · 空闲");
    expect(html).toContain('aria-label="展开侧栏"');
    expect(html).toContain('data-window-mode="macos-overlay"');
    expect(html).toContain('data-sidebar-hidden="true"');
    expect(html).toContain("历史任务");
  });

  it("labels the same control as collapse while the sidebar is visible", () => {
    const html = renderToStaticMarkup(
      <WindowRoomToolbar
        title="Socrates"
        sidebarHidden={false}
        toolbarMode="fullscreen"
        collapseLabel="收起侧栏"
        expandLabel="展开侧栏"
        onToggleSidebar={() => {}}
      />,
    );
    expect(html).toContain('aria-label="收起侧栏"');
    expect(html).toContain('data-window-mode="fullscreen"');
    expect(html).toContain('data-sidebar-hidden="false"');
  });
});
