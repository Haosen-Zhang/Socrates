import type { Components } from "react-markdown";

/**
 * Agent 输出里的 Markdown 链接不能劫持 webview 导航。
 *
 * 之前 `[test.md](test.md)` 渲染成裸 `<a href="test.md">`，点击后 WKWebView 会去加载那个
 * 相对 URL，把整个 SPA 冲走、重载到某个默认房间（就是那个归档的 Nature 房间）。
 * 现在一律 preventDefault：http(s) 交给系统浏览器，其余(工作区相对路径等)不做任何导航。
 */
export function isExternalHref(href: string | undefined): href is string {
  return !!href && /^https?:\/\//iu.test(href);
}

async function openExternal(href: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
  } catch {
    // 非 Tauri 环境(浏览器预览)忽略——反正也不该劫持导航
  }
}

export const MD_COMPONENTS: Components = {
  a({ href, children, ...props }) {
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          if (isExternalHref(href)) void openExternal(href);
        }}
      >
        {children}
      </a>
    );
  },
};
