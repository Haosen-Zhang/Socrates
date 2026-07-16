import React from "react";
import { createRoot } from "react-dom/client";
import PixelIcon from "../../src/PixelIcon";
import GlobalFxLayer from "../../src/fx/GlobalFxLayer";
import "../../src/index.css";
import "./matrix.css";

const ICONS = ["chat", "gear", "general", "plug", "robot", "spark", "brain", "globe", "palette", "plus", "archive", "send"];
const ZOOMS = [0.8, 1, 1.25, 1.5];

function Matrix() {
  return (
    <main className="visual-matrix">
      <GlobalFxLayer />
      <header>
        <div className="pixel-kicker">VISUAL REGRESSION / M1</div>
        <h1>Socrates Micro Icon Matrix</h1>
        <p>Hard-edge micro icons at the exact UI sizes, previewed under common zoom factors.</p>
      </header>
      {(["light", "dark"] as const).map((colorMode) => (
        <div className={`color-panel color-panel--${colorMode}`} key={colorMode}>
          <h2>{colorMode}</h2>
          {(["socrates-classic", "pixel-1998"] as const).map((theme) => (
            <section key={theme}>
              <h3>{theme}</h3>
              {ZOOMS.map((zoom) => (
                <div className="matrix-row" key={zoom}>
                  <strong>{Math.round(zoom * 100)}%</strong>
                  <div className="icon-strip" style={{ zoom }}>
                    {ICONS.map((name) => (
                      <div className="icon-cell" key={name} title={name}>
                        <PixelIcon name={name} size={20} theme={theme} />
                        <span>{name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      ))}
      <section>
        <h2>Decorative sprite (40px minimum)</h2>
        <div className="decorative-strip">
          {ICONS.slice(0, 9).map((name) => (
            <PixelIcon key={name} name={name} size={40} theme="pixel-1998" variant="decorative" />
          ))}
        </div>
      </section>
      <button className="pixel-button pixel-button--primary interaction-target" type="button">
        Click interaction target
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Matrix />);
