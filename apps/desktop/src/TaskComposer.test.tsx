import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import TaskComposer from "./TaskComposer";

describe("TaskComposer", () => {
  it("shows only task input, room policy summary, start, and settings", () => {
    const html = renderToStaticMarkup(
      <TaskComposer
        prompt=""
        summary="团队协作 · 空闲"
        running={false}
        title="新建任务"
        settingsLabel="协作设置"
        promptLabel="任务输入"
        placeholder="描述要完成的任务"
        startLabel="开始任务"
        runningLabel="执行中"
        onPromptChange={() => {}}
        onOpenSettings={() => {}}
        onSubmit={() => {}}
      />,
    );

    expect(html).toContain("新建任务");
    expect(html).toContain("团队协作 · 空闲");
    expect(html).toContain("协作设置");
    expect(html).toContain("开始任务");
    expect(html).toContain("任务输入");
    expect(html).not.toContain("发言顺序");
    expect(html).not.toContain("最大轮数");
    expect(html).not.toContain("计划总结 Agent");
    expect(html).not.toContain("指定执行 Agent");
    expect(html).not.toContain("推理强度");
    expect(html).not.toContain("后备 Agent");
  });
});
