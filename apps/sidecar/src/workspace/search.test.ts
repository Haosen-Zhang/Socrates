import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { searchWorkspacePaths } from "./search";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("searchWorkspacePaths", () => {
  it("returns bounded relative matches and hides secrets", () => {
    const root = `${tmpdir()}/socrates-path-search-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(`${root}/src`, { recursive: true });
    writeFileSync(`${root}/src/index.ts`, "x");
    writeFileSync(`${root}/.env`, "secret");
    expect(searchWorkspacePaths(root, "index")).toEqual([{ relativePath: "src/index.ts", kind: "file" }]);
    expect(JSON.stringify(searchWorkspacePaths(root, "", 20))).not.toContain(".env");
  });
});
