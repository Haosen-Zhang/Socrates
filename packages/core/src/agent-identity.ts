/** Identity sources are portable across saved agents, member snapshots and history. */
export const AGENT_AVATARS = [
  "/avatars/robot-archivist.webp", "/avatars/cyber-fox.webp",
  "/avatars/owl-engineer.webp", "/avatars/axolotl-mechanic.webp",
  "/avatars/slime-alchemist.webp", "/avatars/cat-astronaut.webp",
] as const;

export type AgentIdentity = { nickname: string; avatar: string };
export type AgentNameLanguage = "en" | "zh-CN" | "zh-TW";
export const MAX_AGENT_AVATAR_BYTES = 2 * 1024 * 1024;
export const AGENT_AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

// 32 × 64 readable names per language; no network, model call or personal data.
const PREFIXES: Record<AgentNameLanguage, string[]> = {
  en: "Amber Arctic Astral Autumn Azure Brave Bright Cedar Cobalt Copper Cosmic Crystal Daring Dawn Ember Fern Golden Indigo Ivory Jade Lunar Maple Misty Moss Neon Nova Olive Polar Quiet Silver Solar Velvet".split(" "),
  "zh-CN": "琥珀 霜原 星河 秋日 晴空 勇气 晨光 雪松 钴蓝 赤铜 宇宙 水晶 凌风 黎明 余烬 青蕨 金辉 靛青 象牙 碧玉 月影 枫林 雾海 青苔 霓虹 新星 橄榄 极光 静夜 银翼 日曜 丝绒".split(" "),
  "zh-TW": "琥珀 霜原 星河 秋日 晴空 勇氣 晨光 雪松 鈷藍 赤銅 宇宙 水晶 凌風 黎明 餘燼 青蕨 金輝 靛青 象牙 碧玉 月影 楓林 霧海 青苔 霓虹 新星 橄欖 極光 靜夜 銀翼 日曜 絲絨".split(" "),
};
const NOUNS: Record<AgentNameLanguage, string[]> = {
  en: "Atlas Badger Beacon Birch Brook Comet Coral Crane Crow Dawn Deer Delta Dune Echo Falcon Fern Finch Firefly Fjord Flint Fox Gale Gecko Grove Harbor Hawk Heron Horizon Ibis Kite Lake Lark Leaf Lynx Maple Meadow Meteor Moth Oak Orbit Otter Owl Panda Pebble Pine Piper Pixel Plover Quartz Raven Reef Robin Sage Scout Sequoia Sparrow Spruce Starling Swift Tern Vale Willow Wren Zephyr".split(" "),
  "zh-CN": "旅人 信使 灯塔 向导 溪流 彗星 珊瑚 云鹤 渡鸦 破晓 灵鹿 河谷 沙丘 回声 游隼 青藤 雀鸟 流萤 峡湾 燧石 灵狐 长风 壁虎 森林 海港 苍鹰 白鹭 天际 朱鹮 纸鸢 湖泊 云雀 叶舟 山猫 枫叶 原野 流星 飞蛾 橡树 星轨 水獭 猫头鹰 熊猫 卵石 松针 笛手 像素 鸻鸟 石英 乌鸦 礁石 知更鸟 智者 斥候 巨杉 麻雀 云杉 椋鸟 雨燕 燕鸥 山谷 垂柳 鹪鹩 西风".split(" "),
  "zh-TW": "旅人 信使 燈塔 嚮導 溪流 彗星 珊瑚 雲鶴 渡鴉 破曉 靈鹿 河谷 沙丘 回聲 遊隼 青藤 雀鳥 流螢 峽灣 燧石 靈狐 長風 壁虎 森林 海港 蒼鷹 白鷺 天際 朱鹮 紙鳶 湖泊 雲雀 葉舟 山貓 楓葉 原野 流星 飛蛾 橡樹 星軌 水獺 貓頭鷹 熊貓 卵石 松針 笛手 像素 鴴鳥 石英 烏鴉 礁石 知更鳥 智者 斥候 巨杉 麻雀 雲杉 椋鳥 雨燕 燕鷗 山谷 垂柳 鷦鷯 西風".split(" "),
};

function nameAt(index: number, language: AgentNameLanguage): string {
  const nouns = NOUNS[language];
  return `${PREFIXES[language][Math.floor(index / nouns.length)]}${language === "en" ? " " : ""}${nouns[index % nouns.length]}`;
}

function randomIndex(random: () => number, length: number): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(length - 1, Math.max(0, Math.floor(value * length))) : 0;
}

export function randomAgentIdentity(random: () => number = Math.random, language: AgentNameLanguage = "en"): AgentIdentity {
  return {
    nickname: nameAt(randomIndex(random, PREFIXES[language].length * NOUNS[language].length), language),
    avatar: randomAgentAvatar(random),
  };
}

/** NFKC also catches full-width duplicates; repeated spaces and case are ignored. */
export function normalizeAgentNickname(nickname: string): string {
  return nickname.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function randomUniqueAgentIdentity(
  existingNicknames: Iterable<string>,
  random: () => number = Math.random,
  language: AgentNameLanguage = "en",
): AgentIdentity {
  const used = new Set(Array.from(existingNicknames, normalizeAgentNickname));
  const count = PREFIXES[language].length * NOUNS[language].length;
  const start = randomIndex(random, count);
  const avatar = randomAgentAvatar(random);
  for (let offset = 0; offset < count; offset++) {
    const nickname = nameAt((start + offset) % count, language);
    if (!used.has(normalizeAgentNickname(nickname))) return { nickname, avatar };
  }
  const base = nameAt(start, language);
  for (let suffix = 2; ; suffix++) {
    const nickname = `${base} ${suffix}`;
    if (!used.has(normalizeAgentNickname(nickname))) return { nickname, avatar };
  }
}

// These old defaults must remain stable for records without a stored avatar.
const LEGACY_NAMES = ["青铜档案员", "紫镜狐狸", "蓝羽工程师", "珊瑚修理匠", "薄荷炼金师", "星港领航员", "月面记录官", "霓虹侦察兵", "齿轮观察员", "琥珀质疑者", "电波整理师", "像素裁决官"];
export function agentIdentityFromSeed(seed: string): AgentIdentity {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const index = Math.abs(hash) % LEGACY_NAMES.length;
  return { nickname: LEGACY_NAMES[index], avatar: AGENT_AVATARS[index % AGENT_AVATARS.length] };
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  // Avalanche nearby seeds, so sequential member IDs don't look alike.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

const hex = (value: number) => value.toString(16).padStart(8, "0");
export function agentAvatarFromSeed(seed: string): string {
  return `identicon:v1:${hex(hashSeed(`shape:${seed}`))}${hex(hashSeed(`colour:${seed}`))}`;
}

export function randomAgentAvatar(random: () => number = Math.random): string {
  return agentAvatarFromSeed(`${randomIndex(random, 2 ** 32)}:${randomIndex(random, 2 ** 32)}`);
}

export function isGeneratedAgentAvatar(value: string): boolean {
  return /^identicon:v1:[0-9a-f]{16}$/u.test(value) && value.length === 29;
}

// Background / foreground / accent; silhouettes remain distinct in monochrome.
const PALETTES = [
  ["#162c27", "#b9ef78", "#e9f7cc"], ["#1b2944", "#88c8ff", "#d5eaff"],
  ["#3c2528", "#ffad91", "#ffe1c2"], ["#302547", "#c4a0ff", "#eee0ff"],
  ["#383017", "#f8d36b", "#fff0b3"], ["#173536", "#65dfcf", "#c3fff0"],
  ["#39253a", "#f6a1d3", "#ffe1f1"], ["#2c3420", "#d3e897", "#f3f5d6"],
  ["#332a24", "#e9b380", "#ffdfb4"], ["#222f3b", "#a0d8df", "#dff7f6"],
  ["#39242d", "#ff92aa", "#ffdae3"], ["#252b46", "#a9b7ff", "#e0e5ff"],
] as const;

/** Only our versioned numeric seed can produce SVG; never interpolate user markup. */
export function renderAgentAvatarSvg(source: string): string | null {
  if (!isGeneratedAgentAvatar(source)) return null;
  const seed = source.slice(13);
  const shape = hashSeed(`pixels:${seed}`);
  const detail = hashSeed(`detail:${seed}`);
  const [background, foreground, accent] = PALETTES[hashSeed(`palette:${seed}`) % PALETTES.length];
  const cells: string[] = [];
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 4; col++) {
      const bit = row * 4 + col;
      if (!((shape >>> bit) & 1)) continue;
      const fill = (detail >>> bit) & 1 ? foreground : accent;
      for (const x of col === 3 ? [col] : [col, 6 - col]) {
        cells.push(`<rect x="${8 + x * 8}" y="${8 + row * 8}" width="8" height="8" fill="${fill}"/>`);
      }
    }
  }
  // Extremely sparse seeds still get a visible centre motif.
  if (cells.length < 6) cells.push(`<path d="M24 24h24v24H24z" fill="${foreground}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" shape-rendering="crispEdges"><rect width="72" height="72" fill="${background}"/>${cells.join("")}</svg>`;
}

/** Raster uploads, bundled assets and canonical generated seeds only. */
export function isAgentAvatarSource(value: string): boolean {
  if (isGeneratedAgentAvatar(value) || AGENT_AVATARS.includes(value as (typeof AGENT_AVATARS)[number])) return true;
  const match = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[1].length === 0 || match[1].length % 4 !== 0) return false;
  const padding = match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0;
  const bytes = match[1].length * 3 / 4 - padding;
  return bytes > 0 && bytes <= MAX_AGENT_AVATAR_BYTES;
}
