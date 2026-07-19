import { describe, expect, it } from "bun:test";
import { shallow } from "zustand/vanilla/shallow";
import { GUARDED_KEY_LISTS, HIGH_FREQUENCY_KEYS, pick } from "./selectors";
import type { Store } from "./store";

/**
 * 订阅边界证明链（配合 useShallow 的浅比较语义）：
 * 1. pick 只访问声明的 key；
 * 2. 未声明字段变化时 pick 输出 shallow-equal ⇒ zustand 不触发订阅组件重渲染；
 * 3. 受保护组件清单与高频字段零交集。
 * 合起来即：流式/agent 事件更新不会重渲染 Settings、Providers、MCP、侧栏等组件。
 */

function trackingState(): { state: Store; touched: Set<string> } {
  const touched = new Set<string>();
  const state = new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      touched.add(String(prop));
      return `value:${String(prop)}`;
    },
  }) as unknown as Store;
  return { state, touched };
}

describe("pick 只访问声明字段", () => {
  it("访问集合与声明集合完全一致", () => {
    const { state, touched } = trackingState();
    pick("config", "lang", "setLang")(state);
    expect([...touched].sort()).toEqual(["config", "lang", "setLang"]);
  });

  it("每个受保护清单亦然", () => {
    for (const [name, keys] of Object.entries(GUARDED_KEY_LISTS)) {
      const { state, touched } = trackingState();
      pick(...(keys as readonly (keyof Store)[]))(state);
      expect({ name, touched: [...touched].sort() }).toEqual({ name, touched: [...keys].sort() });
    }
  });
});

describe("无关字段变化时输出浅稳定（= 不重渲染）", () => {
  it("streaming 文本每帧变化不影响设置类 selector 输出", () => {
    const base = {
      config: { theme: "dark" },
      lang: "zh-CN",
      setLang: () => {},
      updateConfig: () => {},
      streaming: { text: "第一帧" },
      agentEvents: [1],
    } as unknown as Store;
    const next = { ...base, streaming: { text: "第一帧第二帧" }, agentEvents: [1, 2] } as unknown as Store;
    const selector = pick("config", "lang", "setLang", "updateConfig");
    expect(shallow(selector(base), selector(next))).toBeTrue();
  });

  it("声明字段变化时输出确实变化（不误吞更新）", () => {
    const base = { config: { theme: "dark" }, lang: "zh-CN" } as unknown as Store;
    const next = { ...base, lang: "en" } as unknown as Store;
    const selector = pick("config", "lang");
    expect(shallow(selector(base), selector(next))).toBeFalse();
  });
});

describe("受保护组件与高频字段零交集", () => {
  it("Settings/Providers/Agents/MCP/侧栏组件不订阅任何高频字段", () => {
    const highFrequency = new Set<string>(HIGH_FREQUENCY_KEYS);
    for (const [name, keys] of Object.entries(GUARDED_KEY_LISTS)) {
      const overlap = keys.filter((key) => highFrequency.has(key));
      expect({ name, overlap }).toEqual({ name, overlap: [] });
    }
  });
});
