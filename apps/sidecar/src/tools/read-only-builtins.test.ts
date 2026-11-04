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

describe("bounded search coverage", () => {
  function fixture() {
    const root = `${tmpdir()}/socrates-coverage-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root);
    const tools = createReadOnlyBuiltins(new WorkspacePathPolicy(root));
    return { root, call: (name: string, input: unknown) => tools.find((tool) => tool.name === name)!.execute!(input, { signal: new AbortController().signal } as never) as Promise<any> };
  }

  it("reports a traversal limit even when there are no matching files", async () => {
    const { root, call } = fixture();
    for (let index = 0; index < 2_001; index++) writeFileSync(`${root}/${String(index).padStart(4, "0")}.txt`, "text");
    const result = await call("search_files", { query: "not-present" });
    expect(result.matches).toEqual([]);
    expect(result.resultTruncated).toBe(false);
    expect(result.coverage).toMatchObject({ traversalTruncated: true, filesScanned: 2_000 });
    expect(result.truncated).toBe(true);
  });

  it("does not claim result truncation at an exactly filled complete result", async () => {
    const { root, call } = fixture();
    writeFileSync(`${root}/many.txt`, `${"needle\n".repeat(200)}`);
    let result = await call("search_text", { query: "needle" });
    expect(result.matches).toHaveLength(200);
    expect(result.resultTruncated).toBe(false);
    writeFileSync(`${root}/many.txt`, `${"needle\n".repeat(201)}`);
    result = await call("search_text", { query: "needle" });
    expect(result.matches).toHaveLength(200);
    expect(result.resultTruncated).toBe(true);
  });

  it("reports file truncation, binary/non-UTF8 skips and clipped match previews", async () => {
    const { root, call } = fixture();
    writeFileSync(`${root}/large.txt`, "needle" + "a".repeat(600_000));
    writeFileSync(`${root}/binary.bin`, Buffer.from([0, 1, 2]));
    writeFileSync(`${root}/unsupported.txt`, Buffer.from([0xff, 0xfe]));
    const result = await call("search_text", { query: "needle" });
    expect(result.coverage).toMatchObject({ filesScanned: 3, fileContentTruncated: 1, binaryFilesSkipped: 1, unsupportedFilesSkipped: 1, matchTextTruncated: 1 });
    expect(result.matches[0]).toMatchObject({ path: "large.txt", line: 1, textTruncated: true });
    expect(result.truncated).toBe(true);
  });

  it("list_directory reports the number of eligible files enumerated", async () => {
    const { root, call } = fixture();
    mkdirSync(`${root}/src`);
    writeFileSync(`${root}/src/a.txt`, "text");
    writeFileSync(`${root}/b.txt`, "text");
    const result = await call("list_directory", { path: "." });
    expect(result.coverage).toMatchObject({ entriesScanned: 3, filesScanned: 2, traversalTruncated: false });
    expect(result.resultTruncated).toBe(false);
  });

  it("read_file returns canonical identity for the entire original file", async () => {
    const { root, call } = fixture();
    writeFileSync(`${root}/a.txt`, "abc");
    expect(await call("read_file", { path: "./a.txt" })).toEqual({ path: "a.txt", text: "abc", byteSize: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", truncated: false });
  });
});
