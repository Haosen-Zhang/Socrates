import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import PixelIcon from "./PixelIcon";

describe("PixelIcon themes", () => {
  it("renders a recognisable modern vector icon for the default theme", () => {
    const html = renderToStaticMarkup(<PixelIcon name="gear" theme="socrates-classic" />);

    expect(html).toContain("pixel-icon__modern");
    expect(html).toContain("lucide-settings");
  });

  it("renders crisp SVG micro icons for every Pixel 1998 navigation icon", () => {
    for (const name of ["chat", "gear", "general", "plug", "robot", "spark", "brain", "globe", "palette"]) {
      const html = renderToStaticMarkup(<PixelIcon name={name} theme="pixel-1998" />);
      expect(html).toContain("pixel-icon__micro");
      expect(html).toContain("pixel-icon__micro--pixel-1998");
      expect(html).not.toContain("pixel-icon__generated");
      expect(html).toContain('data-icon-theme="pixel-1998"');
    }
  });

  it("uses the generated sprite only for an explicitly decorative icon", () => {
    const html = renderToStaticMarkup(<PixelIcon name="chat" theme="pixel-1998" variant="decorative" size={40} />);
    expect(html).toContain("pixel-icon__generated");
    expect(html).not.toContain("pixel-icon__micro");
  });

  it("keeps code-native SVG fallback icons outside the generated set", () => {
    const html = renderToStaticMarkup(<PixelIcon name="send" theme="pixel-1998" />);
    expect(html).not.toContain("pixel-icon__generated");
    expect(html).toContain("pixel-icon__micro");
  });
});
