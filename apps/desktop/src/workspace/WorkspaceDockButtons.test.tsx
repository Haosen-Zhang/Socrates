import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import WorkspaceDockButtons from "./WorkspaceDockButtons";

describe("WorkspaceDockButtons", () => {
  it("exposes one active dock mode and disables both controls without a workspace", () => {
    const active = renderToStaticMarkup(<WorkspaceDockButtons mode="diff" disabled={false} onSelect={() => {}} />);
    expect(active).toContain('aria-pressed="true"');
    expect(active).toContain("pixel-button--primary");

    const disabled = renderToStaticMarkup(<WorkspaceDockButtons mode="closed" disabled onSelect={() => {}} />);
    expect(disabled).toBe("");
  });
});
