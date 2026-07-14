import type { UiTheme } from "@socrates/core";

/** 手绘像素图标：字符网格 → crisp rects，fill=currentColor 跟随主题。比图像生成更适合 UI 小图标。 */

// 每个图标一张位图（`X`/`#` 为实心像素），行等宽
const ICONS: Record<string, string[]> = {
  chat: [
    "XXXXXXXX..",
    "X......X..",
    "X.XXXX.X..",
    "X......X..",
    "X.XXXX.X..",
    "X......X..",
    "XXXXXXXX..",
    "...XX.....",
    "..XX......",
    "..........",
  ],
  gear: [
    "...XX.XX..",
    "..X.XX.X..",
    "XXX.XX.XXX",
    "X..XXXX..X",
    "XX.X..X.XX",
    "XX.X..X.XX",
    "X..XXXX..X",
    "XXX.XX.XXX",
    "..X.XX.X..",
    "...XX.XX..",
  ],
  general: [
    "..X....X..",
    "..X....X..",
    ".XXX..XXX.",
    "..X....X..",
    "..X.XX.X..",
    "....XX....",
    "...XXXX...",
    "....XX....",
    "....XX....",
    "..........",
  ],
  plug: [
    "..X..X....",
    "..X..X....",
    ".XXXXXX...",
    ".XXXXXX...",
    "..XXXX....",
    "...XX.....",
    "...XX.....",
    "...XXXX...",
    "......X...",
    "......X...",
  ],
  robot: [
    "...XX.....",
    "...XX.....",
    ".XXXXXX...",
    "X.XXXX.X..",
    "X.X..X.X..",
    "X.XXXX.X..",
    ".XXXXXX...",
    ".X.XX.X...",
    ".X.XX.X...",
    "..........",
  ],
  spark: [
    "....X.....",
    "....X.....",
    "..X.X.X...",
    "...XXX....",
    "XXXXXXXXX.",
    "...XXX....",
    "..X.X.X...",
    "....X.....",
    "....X.....",
    "..........",
  ],
  brain: [
    "..XXXX....",
    ".X....X...",
    "X.XX.X.X..",
    "X.X..XXX..",
    "X.XX.X.X..",
    "X.X..X.X..",
    ".X.XX.X...",
    "..XXXX....",
    "...X.X....",
    "..........",
  ],
  globe: [
    "..XXXX....",
    ".X.X..X...",
    "X..X...X..",
    "XXXXXXXX..",
    "X..X...X..",
    "X..X...X..",
    ".X.X..X...",
    "..XXXX....",
    "..........",
    "..........",
  ],
  palette: [
    "..XXXX....",
    ".X....X...",
    "X.X.X..X..",
    "X......X..",
    "X.X..X.X..",
    ".X....XX..",
    "..XXXX.X..",
    ".....XX...",
    "..........",
    "..........",
  ],
  send: [
    "....XX....",
    "...XXXX...",
    "..XX..XX..",
    ".XX....XX.",
    "....XX....",
    "....XX....",
    "....XX....",
    "....XX....",
    "..........",
    "..........",
  ],
  plus: [
    "..........",
    "....XX....",
    "....XX....",
    ".XXXXXXXX.",
    ".XXXXXXXX.",
    "....XX....",
    "....XX....",
    "..........",
    "..........",
    "..........",
  ],
  archive: [
    ".XXXXXXXX.",
    "XXXXXXXXXX",
    "XX......XX",
    "XX.XXXX.XX",
    "XX.XXXX.XX",
    "XX......XX",
    "XX......XX",
    "XX......XX",
    "XXXXXXXXXX",
    "..........",
  ],
};

const GENERATED_ICON_CELLS: Record<string, readonly [column: number, row: number]> = {
  chat: [0, 0],
  gear: [1, 0],
  general: [2, 0],
  plug: [0, 1],
  robot: [1, 1],
  spark: [2, 1],
  brain: [0, 2],
  globe: [1, 2],
  palette: [2, 2],
};

export default function PixelIcon({
  name,
  size = 16,
  theme,
}: {
  name: keyof typeof ICONS | string;
  size?: number;
  /** 仅用于设置里的主题预览；正常使用留空并跟随全局 config。 */
  theme?: UiTheme;
}) {
  const grid = ICONS[name];
  const generatedCell = GENERATED_ICON_CELLS[name];
  if (!grid && !generatedCell) return null;
  const cols = grid ? Math.max(...grid.map((r) => r.length)) : 10;
  const rows = grid?.length ?? 10;
  const rects: Array<[number, number]> = [];
  grid?.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "X" || row[x] === "#") rects.push([x, y]);
    }
  });
  return (
    <span
      className={`pixel-icon ${generatedCell ? "pixel-icon--has-generated" : ""}`}
      data-icon-theme={theme}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {generatedCell && (
        <span
          className="pixel-icon__generated"
          style={{ backgroundPosition: `${generatedCell[0] * 50}% ${generatedCell[1] * 50}%` }}
        />
      )}
      {grid && (
        <svg
          className="pixel-icon__classic"
          width={size}
          height={size}
          viewBox={`0 0 ${cols} ${rows}`}
          style={{ shapeRendering: "crispEdges" }}
        >
          {rects.map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />
          ))}
        </svg>
      )}
    </span>
  );
}
