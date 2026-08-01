import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceDockTabs from "./WorkspaceDockTabs";

describe("WorkspaceDockTabs", () => {
  it("orders Overview, Files and Changes and disables workspace tabs without a workspace", () => {
    const html = renderToStaticMarkup(
      <WorkspaceDockTabs mode="overview" hasWorkspace={false} onSelect={() => {}} />,
    );

    expect(html.indexOf(">概览<")).toBeLessThan(html.indexOf(">文件<"));
    expect(html.indexOf(">文件<")).toBeLessThan(html.indexOf(">变更<"));
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html).toContain('role="tablist"');
    expect(html).not.toContain("sr-only");
  });
});
