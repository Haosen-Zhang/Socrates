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
};

export default function PixelIcon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  const grid = ICONS[name];
  if (!grid) return null;
  const cols = Math.max(...grid.map((r) => r.length));
  const rows = grid.length;
  const rects: Array<[number, number]> = [];
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "X" || row[x] === "#") rects.push([x, y]);
    }
  });
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${cols} ${rows}`}
      style={{ shapeRendering: "crispEdges", display: "block" }}
      aria-hidden
    >
      {rects.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />
      ))}
    </svg>
  );
}
