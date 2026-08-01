import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveReasoningProfile } from "@socrates/core";
import ReasoningEffortSelect from "./ReasoningEffortSelect";

describe("ReasoningEffortSelect", () => {
  it("renders one required model-aware select without a second capability row", () => {
    const html = renderToStaticMarkup(
      <ReasoningEffortSelect
        profile={resolveReasoningProfile("openai_compatible", "deepseek-v4-pro")}
        value="auto"
        onChange={() => {}}
      />,
    );

    expect(html.match(/<select/g)?.length).toBe(1);
    expect(html).toContain("required");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('value=""');
    expect(html).toContain('value="auto"');
    expect(html).toContain('value="disabled"');
    expect(html).toContain('value="high"');
    expect(html).toContain('value="max"');
    expect(html).not.toContain('value="medium"');
  });
});
