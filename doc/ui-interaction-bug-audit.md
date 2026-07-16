# Socrates UI 交互缺陷审计

> 审计状态：根因已确认；UI-001 至 UI-004 已于 2026-07-16 实施并通过自动化/浏览器视觉验收，真实 Tauri 窗口的最终主观观感仍由用户确认。
>
> 代码快照：`9f7955d5704918e9e8375b4b89c31a7d44a31a2f`（与当前 `main@48d982c` 文件树一致）。
>
> 范围：Pixel 1998 图标清晰度/尺寸、全局 hover 音效、全局像素粒子。本文不把后续 Agent Workspace UI 纳入当前 bug 修复。

## 1. 结论总览

| ID | 现象 | 严重度 | 根因置信度 | 修复票 |
| --- | --- | --- | --- | --- |
| UI-A1 | Pixel 1998 图标模糊、有紫红边/边缘异常 | P1 视觉 | 已修复 | UI-001 |
| UI-A2 | 顶栏与设置导航图标过小、难辨识 | P1 视觉/可用性 | 已修复 | UI-001 |
| UI-B | 指针在同一按钮图标/文字间移动，hover 音效重复 | P1 交互 | 已修复 | UI-002 |
| UI-C | 粒子只在少数按钮出现，且从元素中心而非真实点击点爆发 | P1 交互 | 已修复 | UI-003 |

三个主根因互相独立：

1. 图标是“资源质量 + 极端缩放 + 非整数 transform + 尺寸不足”，不是单一 CSS 开关。
2. 重复 hover 是 bubbling `pointerover` 的事件语义，不是 AudioContext 或 React effect 重复注册。
3. 粒子不是全局功能；当前 API 只接收 Element 并计算元素中心，组件各自手工接线。

## 2. 审计方法与证据边界

本次只做只读检查：

- 读取 `App.tsx`、`fx.ts`、`PixelIcon.tsx`、`index.css`、`Settings.tsx`、`ChatPage.tsx`、`ProvidersPage.tsx`、`AgentsSection.tsx`。
- 检查 sprite metadata：`1254 × 1254`、PNG、RGBA；代码按 3×3 使用，因此每个 cell 是 `418 × 418`。
- 以原始分辨率查看 `pixel-1998-sprite-clean.png`，确认源图本身包含渐变、软阴影、高光和一圈紫红色 outline/halo。
- 静态推演 DOM pointer event 的 target/relatedTarget 路径，并核对 listener mount/cleanup。
- 枚举全部 `pixelBurst` 调用点，核对全局 listener 的实际职责。
- 当前仓库 `bun test`、`bun run typecheck`、Desktop build 均已通过，因此这些问题不是编译失败，而是缺少正确交互/视觉回归测试。

音效根因不依赖“主观听起来几次”：同一按钮内部产生新的 bubbling `pointerover`，现有 handler 每次都无条件调用 `sfx.hover()`，在代码层可确定。图标审计确认了 source asset 和渲染链；最终修复仍必须用 1x 外接屏和 2x Retina 真机截图验收。

## 3. UI-A1：Pixel 1998 图标模糊与紫红边

### 3.1 最小复现

1. 设置 → 外观 → UI 主题切换为 Pixel 1998。
2. 查看顶栏聊天/设置、设置左侧导航的通用/供应商/Bot/技能/记忆/网络/外观图标。
3. 在 macOS Retina 默认缩放观察，再分别设 WebView zoom 为 100%、125%、150%；若有 1x 外接屏，再移动窗口观察。
4. 与 `socrates-classic` 的网格 SVG 图标比较。

**实际：** generated 图标在 15/16px 最明显地丢失细节，边缘出现紫红色/暗色轮廓，某些 zoom 下边缘宽度不一致；classic rect SVG 更清楚。

**预期：** micro icon 在 1x/2x 与常见 zoom 下保持硬边、无额外 halo；不同图标在导航尺寸仍可辨识。

### 3.2 完整渲染链证据

| 位置 | 当前事实 | 对结果的影响 |
| --- | --- | --- |
| `apps/desktop/public/icons/pixel-1998-sprite-clean.png` | 1254×1254 RGBA，3×3，单 cell 418×418；源图有渐变/软阴影/紫红 outline | 它是大型装饰插画，不是 15px micro icon source |
| `PixelIcon.tsx:153-163` | 9 个 generated icon 映射 sprite cell | 导航图标全部走同一大图采样路径 |
| `PixelIcon.tsx:187-197` | 外层 width/height 等于调用方 `size`，内部 span 用 background-position | 浏览器把 418px cell压进15/16/28 CSS px |
| `index.css:26-35` | `background-size:300% 300%`、`image-rendering:pixelated`、`transform:scale(1.16)` | 先极端降采样，再用fractional scale使device-pixel mapping不稳定 |
| `index.css:36-41` | Pixel 1998 theme隐藏classic SVG并显示generated layer | 无清晰fallback参与最终显示 |
| `App.tsx:55-64` | 顶栏 `PixelIcon size={15}` | 418→15，约27.9倍缩小 |
| `Settings.tsx:298-311` | 设置导航 `size={16}` | 418→16，约26.1倍缩小 |
| `Settings.tsx:244-246` | 主题预览为28px | 即使预览位也约14.9倍缩小，但比导航稍可辨 |

`image-rendering: pixelated` 只影响采样策略，不能把源图已有的半透明/渐变/紫边重新变成干净的 8/10/16 像素网格。`scale(1.16)` 还让 15px 视觉层变成 17.4 CSS px、16px 变成 18.56 CSS px；在 DPR/zoom 组合下不一定落在整数 device pixels。

### 3.3 已排除的错误方向

- **不是字体导致：** 图标是 background image/SVG，与根 font family 无关。
- **不是缺 `image-rendering: pixelated`：** 当前已经有；问题仍存在且它无法修复 source halo。
- **不是所有 PixelIcon 都坏：** `PixelIcon.tsx:199-210` 的 classic renderer是10×10 rect SVG，并用 `shapeRendering:crispEdges`；它提供了有效对照。
- **不是简单把 `scale(1.16)` 改成 `1` 就全部修好：** 这会减少非整数映射，但 418px软边插画降到15px仍会丢细节/保留色边。
- **不应对整张图做 CSS blur/sharpen/filter：** filter只能制造新的颜色/alias，不能重建micro icon设计。

### 3.4 推荐修复设计

1. 保留 `PixelIcon` 单一调用 API，但增加明确 variant：`micro` 与 `decorative`。
2. 为 chat/gear/general/plug/robot/spark/brain/globe/palette 重新绘制 8×8、10×10 或 16×16 的硬边 micro icon：优先多色 SVG `<rect>`；若用 PNG，提供精确 1x/2x 且禁止运行时 fractional transform。
3. 现有 1254px sprite 只用于 ≥32px 装饰/主题预览，不用于导航。
4. 删除 `.pixel-icon__generated { transform: scale(1.16) }`；外层尺寸和绘制 grid 用整数。
5. 顶栏 icon 提升到18–20px，设置导航至少20px；button hit target至少36×36px。图标大小与点击区域分开定义。
6. 每个 theme 使用 tokens：`--icon-micro`、`--icon-nav`、`--icon-decorative`，调用方不再散落15/16等魔法数字。
7. 经典主题继续保留当前 crisp rect SVG，不能给所有 SVG 全局加 `image-rendering:pixelated`。

### 3.5 自动测试

`PixelIcon.test.tsx` 增加结构断言：

- Pixel 1998 micro icon不引用大型sprite、不包含CSS transform。
- classic theme仍显示rect SVG；theme preview可明确使用decorative variant。
- size token是整数且nav不小于20；button hit target不小于36。
- generated/decorative资源若保留，不能在micro位置渲染。

视觉测试见第7节；不能只靠DOM snapshot关闭该票。

## 4. UI-A2：设置/顶栏图标尺寸不足

这不是独立渲染 bug，而是 UI-A1 的可用性放大器，和资源修复必须同票完成。

### 4.1 代码证据

- `App.tsx:62`：聊天/设置 tab 固定15px。
- `Settings.tsx:307`：7个设置导航图标固定16px。
- `ChatPage.tsx:977`：归档icon 15px；`ChatPage.tsx:961` 新建房间16px。
- 与之相比，主题预览在 `Settings.tsx:244-246` 用28px，说明generated art本就需要更大显示空间。

当前 top tab button 的视觉层级依赖小图+文字，但 Pixel 1998 图标细节远超15px容量。设置左侧7个图标也是主要定位线索，16px降低扫描效率；只放大source image不会解决hit target。

### 4.2 验收标准

- top tab micro icon 18–20px；settings nav 20–22px；sidebar utility 18–20px。
- 每个交互项点击区域至少36×36px，文字baseline和icon视觉中心对齐。
- 320/640/默认桌面宽度下不因放大图标截断label；设置nav仍可滚动。
- 200% text zoom下图标不覆盖文字，布局不横向溢出。
- 所有尺寸来自集中token，主题切换不改变layout width造成抖动。

## 5. UI-B：同一按钮内部移动导致 hover 音效重复

### 5.1 最小复现

1. 设置中开启声音。
2. 将指针从按钮外移动到按钮留白；会听到一次hover。
3. 不离开按钮，把指针移到按钮里的 PixelIcon、文字或span。
4. 每次跨子节点边界都可能再次听到hover。

**预期：** 进入一个 enabled interactive root一次；只在离开后重入或从按钮A进入按钮B时再次播放。

### 5.2 代码路径

`App.tsx:38-53`：

```ts
const isBtn = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.("button");
const onOver = (e: MouseEvent) => {
  if (isBtn(e.target)) sfx.hover();
};
document.addEventListener("pointerover", onOver, { passive: true });
```

`pointerover` 会冒泡，并且在指针进入后代元素时再次派发。现有handler只问“新target能否找到某个button”，没有问“relatedTarget是否已经在同一个button内”。

事件序列示例：

| 移动 | `target.closest(button)` | `relatedTarget.closest(button)` | 当前行为 | 正确行为 |
| --- | --- | --- | --- | --- |
| 外部 → Button A | A | null | 播放 | 播放 |
| A 背景 → A 内 icon | A | A | 再播放 | 不播放 |
| A icon → A 内 text | A | A | 再播放 | 不播放 |
| A → Button B | B | A | 播放 | 播放 |
| 离开 A → 外部 | null | A | 不播放 | 不播放 |
| 外部 → A（重入） | A | null | 播放 | 播放 |

### 5.3 已排除的错误方向

- `App.tsx:49-52` 有对应 cleanup，effect 依赖是空数组；没有证据表明listener永久叠加。
- `fx.ts:6` 只有一个module-level `audioCtx`，`ctx()` 在 `fx.ts:13-21` 复用它；不是每次hover创建长期AudioContext导致的重复。
- `sfx.hover` 本身只调用一个 `blip`（`fx.ts:40-42`）；重复来自handler被多次触发。
- debounce会掩盖而非修正语义，并可能吞掉用户快速从A移动到B的合法反馈。

### 5.4 推荐修复设计

提取纯函数 `getInteractiveRoot(target)` 与 `isInteractiveEntry(target, relatedTarget)`：

```ts
const next = getInteractiveRoot(event.target);
const previous = getInteractiveRoot(event.relatedTarget);
if (next && next !== previous && isEnabled(next)) sfx.hover();
```

- 保留一个document delegated listener，避免每个按钮接线。
- selector集中管理，首票至少覆盖`button`；如果以后加入`[role=button]`/link，必须同时定义disabled规则。
- disabled、`aria-disabled=true`、hidden/inert interactive root不播放。
- listener使用与事件类型一致的`PointerEvent`类型；mount/unmount严格成对。
- 不改变click声音；click和hover计数分开测试。

### 5.5 回归测试

纯函数table tests覆盖上表，再用DOM test派发真实`pointerover`：

- nested svg/path/span之间移动0次；
- 两个相邻按钮切换1次；
- disabled 0次；
- component rerender 10次后一次进入仍只调用1次；
- sound setting off时0次、重新on后1次；
- trackpad/mouse都走pointer路径；touch不因synthetic hover产生噪声。

## 6. UI-C：粒子非全局且位置错误

### 6.1 最小复现

1. 点击关闭新房间/成员弹窗、删除Provider/Agent、归档/删除Room：有粒子。
2. 点击普通按钮、消息、设置项、页面空白：没有粒子。
3. 在一个宽按钮左侧或右侧点击：粒子仍从按钮几何中心爆发，而不是指针位置。

**预期：** 所有真实鼠标/触控板/tap click在`clientX/clientY`位置产生一次粒子；键盘激活保持按钮功能与音效，但不在(0,0)生成伪粒子。

### 6.2 代码证据

`fx.ts:55-60`：

```ts
export function pixelBurst(el: Element | null, color = "#8a6ff0"): void {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
}
```

API没有事件坐标，因而无法满足“点击哪里从哪里爆发”。`App.tsx:44-48` 的全局delegation只播放button click音效，没有调用particle。

当前手工接线点：

| 文件 | 行 | 操作 |
| --- | --- | --- |
| `ChatPage.tsx` | 658–660 | 新房间弹窗关闭 |
| `ChatPage.tsx` | 775–779 | Room归档/恢复 |
| `ChatPage.tsx` | 790–793 | Room删除确认 |
| `ChatPage.tsx` | 826–829 | 群成员弹窗关闭 |
| `ProvidersPage.tsx` | 98–100 | Provider删除 |
| `ProvidersPage.tsx` | 208–210 | Provider编辑弹窗关闭 |
| `AgentsSection.tsx` | 157–159 | Agent删除 |
| `AgentsSection.tsx` | 187–189 | Agent编辑弹窗关闭 |

因此当前“只在关闭/删除/归档有”是代码设计现状，不是z-index或动画偶发失败。

### 6.3 推荐修复设计

1. `fx.ts` 提供 `pixelBurstAt(clientX, clientY, options)`；不接受Element。
2. `GlobalFxLayer`只挂一次capture-phase `click` listener。使用click而不是裸`pointerup`，让浏览器先完成drag/cancel/disabled判定。
3. 仅处理`event.detail > 0`且坐标有限的pointer-generated click。键盘激活通常`detail=0`，不生成(0,0)粒子。
4. 删除上表所有局部`pixelBurst`调用。声音的semantic close/delete仍可保留；粒子只能有一个owner。
5. 每个burst的DOM粒子放到固定overlay或body，`pointer-events:none`，z-index有token；animation完成/取消都remove。
6. 并发粒子节点有硬上限，例如最多120个；超过时复用/丢弃最旧，防止rapid click拖垮WebView。
7. `prefers-reduced-motion:reduce`时完全不创建节点；声音由独立sound setting控制。
8. 如果未来只想对primary button生效，明确检查`MouseEvent.button===0`；`click`本身已经过滤大部分secondary动作，contextmenu不能触发。

### 6.4 为什么必须同时删除局部调用

若只新增全局listener，关闭/删除等现有handler会同时调用局部center burst与全局pointer burst，用户会看到两次、两个中心。UI-003的验收必须用call/node计数证明每次click恰好一次，而不是视觉上“差不多”。

### 6.5 回归测试

- 页面空白、普通button、modal close、delete confirm各1次。
- 宽按钮左/中/右点击，初始粒子位置与`clientX/Y`误差≤2 CSS px。
- local callsites经`rg "pixelBurst"`只剩global layer/API/test，无业务组件调用。
- keyboard Enter/Space激活按钮：业务动作1次、粒子0次、无(0,0)节点。
- reduced motion：粒子0节点；click声音仍按sound setting。
- rapid 50 clicks：节点数不超过预算，动画结束归零。
- click后组件立即unmount仍能cleanup；应用view切换不增加listener。

## 7. 视觉与交互验证矩阵

### 7.1 图标矩阵

固定窗口、字体和mock数据，对以下组合截图：

| 维度 | 值 |
| --- | --- |
| UI theme | `socrates-classic`、`pixel-1998` |
| color theme | light、dark |
| DPR | 1、2 |
| WebView zoom | 80%、100%、125%、150% |
| 位置 | top tabs、settings nav、new room/archive、composer controls、theme preview |
| 状态 | normal、hover、active、disabled、focus-visible |

关键断言：

- micro icon边界颜色集合符合资源palette，没有source sprite的magenta halo。
- icon视觉bounds落在整数CSS px；computed transform为none。
- theme切换不改变button width/文本位置。
- dark/light对比度和focus ring均可见。
- classic rect SVG仍保持crisp，不被generated theme CSS污染。

### 7.2 Hover 事件矩阵

| 输入 | 路径 | 期望hover次数 |
| --- | --- | --- |
| mouse | outside→button | 1 |
| mouse | button→nested icon→text | 0 |
| mouse | A→B | 1 |
| trackpad | outside→button→child | 1 total |
| touch | tap button | 0 hover，1 click |
| keyboard | Tab focus | 0 hover |
| rerender | same DOM root after state update | 不增加listener |
| disabled | outside→disabled | 0 |

### 7.3 Particle 矩阵

| 输入/位置 | 业务动作 | 粒子 |
| --- | --- | --- |
| mouse primary click，普通区 | 无/selection | 1 at pointer |
| trackpad click，button | 1 | 1 at pointer |
| touch tap | 1 | 1 at synthesized click coordinate |
| right click/contextmenu | context menu | 0 |
| drag ending over target | drag/drop | 0，除非浏览器合法产生click |
| disabled control | 0 | 0 |
| keyboard Enter/Space | 1 | 0 |
| reduced motion | 1 | 0 |
| local close/delete | 1 | 恰好1，不是2 |

## 8. 可访问性、性能与降级

- 音效与粒子都是增强层，不能承载唯一状态反馈；关闭声音/reduced motion时功能完整。
- focus变化不播放hover，避免键盘用户每次Tab都有噪声；click sound是否用于键盘激活需产品统一决定，但与粒子分离。
- 图标`aria-hidden`，button必须有可见label或`aria-label`；放大icon不能替代hit target。
- 颜色不能是唯一active/危险标记；Pixel 1998 palette在light/dark分别测对比。
- Global listener单例，有cleanup；粒子节点有budget，动画promise成功/失败都remove。
- 视觉测试不以大范围pixel tolerance掩盖模糊；micro icon区域用严格阈值，文字区域允许平台字体差异。
- 若Web Audio不可用，`fx.ts`现有try/catch静默降级可保留；不得因音效失败阻断click。

## 9. 建议实施与验证顺序

1. UI-001：先替换micro resource/rendering和尺寸token，建立可比较的静态画面。
2. UI-002：提取interactive entry纯函数并接回单一listener。
3. UI-003：增加global click layer，再一次性删除全部local burst callsites。
4. UI-004：锁定自动截图/事件矩阵，并在1x/2x真机验收。

不建议在这四票中顺手重构Chat composer、Settings信息架构或Agent Workspace状态；P0的目标是建立一个小而可信的UI回归基线。

## 10. Definition of Done

- [ ] Pixel 1998 micro icon不再从418px cell缩到15/16px，不含fractional transform。
- [ ] top tab、settings nav、utility icon与hit target达到第4节尺寸门槛。
- [ ] 图标矩阵在1x/2x、四档zoom、light/dark和两个UI theme通过。
- [ ] 同一interactive root内部移动hover 0次；进入新root恰好1次。
- [ ] 所有pointer-generated click在真实坐标恰好1个burst；keyboard/reduced-motion 0个。
- [ ] `ChatPage`、`ProvidersPage`、`AgentsSection`不再直接调用particle API。
- [ ] listener和动画节点在view切换/unmount后归零，无性能泄漏。
- [ ] classic theme、IME、按钮业务动作、context menu、dark theme无回归。
- [ ] `bun test`、`bun run typecheck`、Desktop build和UI-004 visual command全部通过。
