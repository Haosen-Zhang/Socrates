import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { createReadOnlyBuiltins } from "./read-only-builtins";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("read-only builtin tools", () => {
  it("lists, finds and searches bounded workspace content without secrets", async () => {
    const root = `${tmpdir()}/socrates-builtins-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(`${root}/src`, { recursive: true });
    writeFileSync(`${root}/src/a.ts`, "const needle = 1;\n");
    writeFileSync(`${root}/src/b.ts`, "const other = 2;\n");
    writeFileSync(`${root}/.env`, "needle=secret\n");
    const tools = createReadOnlyBuiltins(new WorkspacePathPolicy(root));
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const context = { signal: new AbortController().signal } as never;
    expect(await byName.get("list_directory")!.execute!({ path: "src" }, context)).toMatchObject({ entries: ["src/a.ts", "src/b.ts"] });
    expect(await byName.get("search_files")!.execute!({ query: "a.ts" }, context)).toMatchObject({ matches: ["src/a.ts"] });
    const text = await byName.get("search_text")!.execute!({ query: "needle" }, context) as { matches: unknown[] };
    expect(text.matches).toHaveLength(1);
    expect(JSON.stringify(text)).not.toContain(".env");
    expect(await byName.get("read_file")!.execute!({ path: "src/a.ts" }, context)).toMatchObject({ text: "const needle = 1;\n" });
  });
});
