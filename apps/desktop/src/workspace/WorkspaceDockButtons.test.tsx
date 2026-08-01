import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceDockButtons from "./WorkspaceDockButtons";

describe("WorkspaceDockButtons", () => {
  it("exposes one compact overview trigger instead of duplicating dock tabs in the toolbar", () => {
    const active = renderToStaticMarkup(<WorkspaceDockButtons mode="overview" onSelect={() => {}} />);
    expect(active).toContain('aria-pressed="true"');
    expect(active).toContain("pixel-button--primary");
    expect(active.match(/<button/g)?.length).toBe(1);
    expect(active).toContain("workspace_overview");
  });
});
