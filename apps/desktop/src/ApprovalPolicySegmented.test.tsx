import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ApprovalPolicySegmented from "./ApprovalPolicySegmented";

const labels = { ask: "询问", auto_safe: "自动", workspace_full: "Yolo" } as const;
const descriptions = { ask: "ask", auto_safe: "auto", workspace_full: "yolo" } as const;
const options = (["ask", "auto_safe", "workspace_full"] as const).map((mode) => ({
  mode,
  supported: mode !== "workspace_full",
  labelKey: `approval_mode_${mode}` as const,
  descriptionKey: `approval_mode_${mode}_description` as const,
}));

describe("ApprovalPolicySegmented", () => {
  it("renders one accessible three-way policy control with capability gating", () => {
    const html = renderToStaticMarkup(
      <ApprovalPolicySegmented
        value="auto_safe"
        options={options}
        labels={labels}
        descriptions={descriptions}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('data-active="auto_safe"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('>询问<');
    expect(html).toContain('>自动<');
    expect(html).toContain('>Yolo<');
    expect(html).toContain("disabled");
    expect(html).not.toContain("<select");
  });
});
