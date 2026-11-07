import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActorPicker } from "./ActorPicker";
import { DetailPanel, Tooltip } from "./overlays";
import { ActivityTimeline, EmptyState, ErrorNotice, LoadingState, ObjectPage, StatusBadge } from "./components";
import { Notifications } from "./Notifications";

describe("foundation component contracts", () => {
  it("keeps the selected actor controlled by id and labels the searchable input", () => {
    const html = renderToStaticMarkup(<ActorPicker label="默认回应者" actors={[
      { id: "one", label: "Ada", description: "Reviewer" },
      { id: "two", label: "Lin", disabled: true, disabledReason: "Provider 未配置" },
    ]} value="one" onChange={() => {}} placeholder="搜索成员" emptyLabel="没有匹配的成员" />);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('value="Ada"');
    expect(html).toContain('placeholder="搜索成员"');
    const inputId = /<input[^>]*id="([^"]+)"/.exec(html)?.[1];
    expect(inputId).toBeDefined();
    expect(html).toContain(`for="${inputId}"`);
    expect(html).not.toContain("online");
  });

  it("gives inline detail and object pages labelled headings without creating a second modal", () => {
    const html = renderToStaticMarkup(<ObjectPage title="Project" description="Local workspace" actions={<button>Open room</button>}>
      <DetailPanel title="Room details" open drawer={false} closeLabel="Close details" onClose={() => {}}><p>Original room content</p></DetailPanel>
    </ObjectPage>);
    expect(html).toContain("<h1");
    expect(html).toContain("<aside");
    expect(html).toContain('aria-label="Close details"');
    expect(html).toContain("Original room content");
    expect(html).not.toContain('aria-modal="true"');
    expect(renderToStaticMarkup(<DetailPanel title="Hidden" open={false} drawer={false} onClose={() => {}}>Hidden content</DetailPanel>)).toBe("");
  });

  it("keeps provenance, errors, loading and empty states explicit in caller language", () => {
    const html = renderToStaticMarkup(<>
      <StatusBadge source="上次检查：未知">状态未知</StatusBadge>
      <EmptyState title="尚無工作事項" description="先選擇工作房間" action={<button>開啟房間</button>} />
      <ErrorNotice message="读取失败" onRetry={() => {}} retryLabel="重试" />
      <LoadingState label="Loading room" />
      <ActivityTimeline items={[{ id: "a", title: "Room created", description: "From stored event", timestamp: "2026-11-07T00:00:00Z" }]} />
    </>);
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain("上次检查：未知");
    expect(html).toContain('role="alert"');
    expect(html).toContain('role="status"');
    expect(html).toContain("尚無工作事項");
    expect(html).toContain("重试</button>");
    expect(html).toContain('<time dateTime="2026-11-07T00:00:00Z">');
  });

  it("reuses the accessible resize handle only in a wide detail panel", () => {
    const html = renderToStaticMarkup(<DetailPanel title="Task" open drawer={false} onClose={() => {}}
      resize={{ size: 360, min: 280, max: 520, label: "调整详情宽度", onResize: () => {}, onCommit: () => {} }}>
      Task contents
    </DetailPanel>);
    expect(html).toContain('style="width:360px;flex:none"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="调整详情宽度"');
    expect(html).toContain('aria-valuenow="360"');
  });

  it("attaches tooltips to the caller button without nesting interactive elements", () => {
    const html = renderToStaticMarkup(<Tooltip label="Open details"><button type="button">Details</button></Tooltip>);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Details</button>");
  });

  it("provides a localized polite notification region without taking initial focus", () => {
    const html = renderToStaticMarkup(<Notifications closeLabel="關閉通知" label="通知" />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="通知"');
    expect(html).not.toContain("autofocus");
  });
});
