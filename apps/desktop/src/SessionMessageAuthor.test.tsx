import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SessionMessageAuthor from "./SessionMessageAuthor";

describe("historical message author", () => {
  it("keeps the run's original model and identity after a room template update", () => {
    const html = renderToStaticMarkup(
      <SessionMessageAuthor
        message={{
          authorId: "member",
          authorSnapshot: {
            nickname: "Original author",
            modelId: "original-model",
            avatar: "/original.png",
          },
        }}
        roomSnapshot={{
          nickname: "Updated author",
          modelId: "updated-model",
          avatar: "/updated.png",
        }}
      />,
    );
    expect(html).toContain("Original author");
    expect(html).toContain("original-model");
    expect(html).toContain("/original.png");
    expect(html).not.toContain("Updated author");
    expect(html).not.toContain("updated-model");
    expect(html).not.toContain("/updated.png");
  });
  it("can render a frozen author after the member has been removed", () => {
    const html = renderToStaticMarkup(
      <SessionMessageAuthor
        message={{
          authorId: "removed",
          authorSnapshot: {
            nickname: "Former member",
            modelId: "frozen-model",
          },
        }}
      />,
    );
    expect(html).toContain("Former member");
    expect(html).toContain("frozen-model");
  });
  it("uses the room member snapshot as a compatibility fallback for old messages", () => {
    const html = renderToStaticMarkup(
      <SessionMessageAuthor
        message={{ authorId: "member" }}
        roomSnapshot={{ nickname: "Room member", modelId: "room-model" }}
      />,
    );
    expect(html).toContain("Room member");
    expect(html).toContain("room-model");
  });
});
