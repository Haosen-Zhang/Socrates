import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import PixelIcon from "./PixelIcon";

describe("PixelIcon themes", () => {
  it("provides generated sprite cells for chat, settings, and every settings navigation icon", () => {
    for (const name of ["chat", "gear", "general", "plug", "robot", "spark", "brain", "globe", "palette"]) {
      const html = renderToStaticMarkup(<PixelIcon name={name} theme="pixel-1998" />);
      expect(html).toContain("pixel-icon--has-generated");
      expect(html).toContain("pixel-icon__generated");
      expect(html).toContain('data-icon-theme="pixel-1998"');
    }
  });

  it("keeps code-native SVG fallback icons outside the generated set", () => {
    const html = renderToStaticMarkup(<PixelIcon name="send" theme="pixel-1998" />);
    expect(html).not.toContain("pixel-icon--has-generated");
    expect(html).toContain("pixel-icon__classic");
  });
});
