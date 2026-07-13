/**
 * 零依赖 8-bit 音效与像素粒子特效。
 * 音效用 Web Audio 方波实时合成（无音频文件）；粒子用 DOM 方块 + WAAPI。
 * 可通过 setSfxEnabled 关闭；尊重 prefers-reduced-motion（粒子）。
 */
let audioCtx: AudioContext | null = null;
let sfxEnabled = true;

export function setSfxEnabled(on: boolean): void {
  sfxEnabled = on;
}

function ctx(): AudioContext | null {
  if (!sfxEnabled) return null;
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return audioCtx;
  } catch {
    return null; // WebAudio 不可用时静默降级
  }
}

/** 一个方波音符 */
function blip(freq: number, durMs: number, gain = 0.05, delayMs = 0): void {
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime + delayMs / 1000;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(freq, t0);
  amp.gain.setValueAtTime(gain, t0);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(amp).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000);
}

export const sfx = {
  hover: () => blip(660, 40, 0.02),
  click: () => blip(520, 55, 0.05),
  open: () => blip(740, 70, 0.05),
  close: () => blip(300, 90, 0.05),
  send: () => {
    blip(520, 60, 0.05);
    blip(780, 70, 0.05, 55);
  },
  delete: () => {
    blip(240, 80, 0.05);
    blip(160, 110, 0.05, 70);
  },
};

/** 从某个元素中心迸发一圈像素方块，短暂后消失 */
export function pixelBurst(el: Element | null, color = "#8a6ff0"): void {
  if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const n = 12;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("div");
    const size = 4 + Math.floor(Math.random() * 3);
    Object.assign(p.style, {
      position: "fixed",
      left: `${cx}px`,
      top: `${cy}px`,
      width: `${size}px`,
      height: `${size}px`,
      background: color,
      zIndex: "200",
      pointerEvents: "none",
      imageRendering: "pixelated",
    });
    document.body.appendChild(p);
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const dist = 26 + Math.random() * 26;
    p.animate(
      [
        { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
        {
          transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0)`,
          opacity: 0,
        },
      ],
      { duration: 360, easing: "steps(5, end)" },
    ).finished.then(() => p.remove(), () => p.remove());
  }
}
