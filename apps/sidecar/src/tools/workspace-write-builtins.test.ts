import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";
import ExcelJS from "exceljs";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { SupervisedCommandRunner } from "./workspace-command-runner";
import { createWorkspaceWriteBuiltins } from "./workspace-write-builtins";

describe("workspace-write builtins", () => {
  const tmp = join(tmpdir(), `socrates-ws-write-test-${crypto.randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, ".gitkeep"), "");
  const policy = new WorkspacePathPolicy(tmp);
  const commandPaths = new Map([
    ["echo", "/bin/echo"],
    ["git", "/usr/bin/git"],
  ]);
  const runner = new SupervisedCommandRunner((_workspaceRoot, input) => ({
    executable: commandPaths.get(input.executable) ?? input.executable,
    argv: input.argv,
    env: { PATH: "/usr/bin:/bin", HOME: tmp, TMPDIR: tmp },
  }));
  const tools = createWorkspaceWriteBuiltins(policy, runner);
  const context = {
    callId: "call",
    sessionId: "session",
    taskId: "task",
    turnId: "turn",
    agentId: "agent",
    mode: "single_agent",
    phase: "executing",
    signal: new AbortController().signal,
  } as const;

  // Note: workspace is created in tmpdir(), cleaned up by OS

  it("write_file creates a new file inside workspace", async () => {
    const writeTool = tools.find((t) => t.name === "write_file")!;
    expect(writeTool).toBeDefined();
    expect(writeTool.risk).toBe("high");

    const result = (await writeTool.execute!({ path: "hello.txt", content: "hello world\n" }, {} as any)) as any;
    expect(result.action).toBe("created");
    expect(result.path).toBe("hello.txt");
    expect(existsSync(join(tmp, "hello.txt"))).toBe(true);
    expect(readFileSync(join(tmp, "hello.txt"), "utf-8")).toContain("hello world");
  });

  it("write_file overwrites existing files", async () => {
    const writeTool = tools.find((t) => t.name === "write_file")!;
    // Create first
    await writeTool.execute!({ path: "overwrite.txt", content: "old line 1\nold line 2\n" }, {} as any);

    const result = (await writeTool.execute!({ path: "overwrite.txt", content: "new line 1\nnew line 2\nnew line 3\n" }, {} as any)) as any;
    expect(result.action).toBe("overwritten");
    expect(result.newLines).toBeGreaterThanOrEqual(3);
    expect(typeof result.previousLines).toBe("number");
    expect(readFileSync(join(tmp, "overwrite.txt"), "utf-8")).toContain("new line 1");
  });

  it("write_file rejects path traversal", async () => {
    const writeTool = tools.find((t) => t.name === "write_file")!;
    await expect(
      writeTool.execute!({ path: "../outside.txt", content: "nope" }, {} as any),
    ).rejects.toThrow();
  });

  it("write_file refuses to overwrite a hardlink to an outside inode", async () => {
    const writeTool = tools.find((tool) => tool.name === "write_file")!;
    const outside = join(tmp, "..", `outside-hardlink-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "outside");
    const { linkSync } = await import("node:fs");
    linkSync(outside, join(tmp, "hardlink.txt"));
    try {
      await expect(writeTool.execute!({ path: "hardlink.txt", content: "changed" }, context))
        .rejects.toThrow("workspace_hardlink_denied");
      expect(readFileSync(outside, "utf-8")).toBe("outside");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("delete_path deletes an in-workspace file and an explicitly empty directory", async () => {
    const deleteTool = tools.find((tool) => tool.name === "delete_path")!;
    expect(deleteTool).toMatchObject({ risk: "destructive", capability: "workspace_write" });
    writeFileSync(join(tmp, "remove.txt"), "remove me");
    mkdirSync(join(tmp, "empty"));

    expect(deleteTool.validateInput?.({ path: "remove.txt" })).toEqual([]);
    await expect(deleteTool.execute!({ path: "remove.txt" }, context)).resolves.toMatchObject({
      action: "deleted",
      path: "remove.txt",
      kind: "file",
    });
    await expect(deleteTool.execute!({ path: "empty" }, context)).resolves.toMatchObject({
      action: "deleted",
      path: "empty",
      kind: "directory",
    });
    expect(existsSync(join(tmp, "remove.txt"))).toBe(false);
    expect(existsSync(join(tmp, "empty"))).toBe(false);
  });

  it("delete_path rejects non-empty directories, secrets, traversal, and symlinks", () => {
    const deleteTool = tools.find((tool) => tool.name === "delete_path")!;
    mkdirSync(join(tmp, "not-empty"), { recursive: true });
    writeFileSync(join(tmp, "not-empty", "keep.txt"), "keep");
    const outside = join(tmp, "..", `outside-${crypto.randomUUID()}.txt`);
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(tmp, "outside-link"));
    try {
      expect(deleteTool.validateInput?.({ path: "not-empty" })).toContain("workspace_directory_not_empty");
      expect(deleteTool.validateInput?.({ path: ".env" })).toContain("workspace_secret_path_denied");
      expect(deleteTool.validateInput?.({ path: "../outside.txt" })).toContain("workspace_path_traversal");
      expect(deleteTool.validateInput?.({ path: "outside-link" })).toContain("workspace_symlink_denied");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("creates directories, copies trees, and moves paths without shell fallback", async () => {
    const createDirectory = tools.find((tool) => tool.name === "create_directory")!;
    const copyPath = tools.find((tool) => tool.name === "copy_path")!;
    const movePath = tools.find((tool) => tool.name === "move_path")!;
    mkdirSync(join(tmp, "source", "empty"), { recursive: true });
    writeFileSync(join(tmp, "source", "note.txt"), "hello");

    await expect(createDirectory.execute!({ path: "created/nested" }, context)).resolves.toEqual({
      action: "created",
      kind: "directory",
      path: "created/nested",
    });
    await expect(copyPath.execute!({ source: "source", destination: "copied" }, context)).resolves
      .toMatchObject({ action: "copied", kind: "directory", entries: 2, byteSize: 5 });
    expect(readFileSync(join(tmp, "copied", "note.txt"), "utf-8")).toBe("hello");
    expect(existsSync(join(tmp, "copied", "empty"))).toBe(true);
    expect(movePath).toMatchObject({ risk: "destructive", capability: "workspace_write" });
    await expect(movePath.execute!({ source: "copied/note.txt", destination: "renamed.txt" }, context))
      .resolves.toMatchObject({ action: "moved", from: "copied/note.txt", to: "renamed.txt" });
    expect(readFileSync(join(tmp, "renamed.txt"), "utf-8")).toBe("hello");
  });

  it("creates bounded ZIP archives containing workspace files", async () => {
    const archive = tools.find((tool) => tool.name === "create_archive")!;
    mkdirSync(join(tmp, "archive-source"), { recursive: true });
    writeFileSync(join(tmp, "archive-source", "one.txt"), "one");
    writeFileSync(join(tmp, "archive-source", "two.txt"), "two");

    await expect(archive.execute!({
      path: "exports/files.zip",
      sources: ["archive-source"],
    }, context)).resolves.toMatchObject({
      action: "created",
      format: "zip",
      path: "exports/files.zip",
      entries: 2,
    });
    const files = unzipSync(readFileSync(join(tmp, "exports", "files.zip")));
    expect(Buffer.from(files["archive-source/one.txt"]!).toString("utf-8")).toBe("one");
    expect(Buffer.from(files["archive-source/two.txt"]!).toString("utf-8")).toBe("two");

    mkdirSync(join(tmp, "empty-archive-source"));
    const emptyResult = await archive.execute!({
      path: "exports/empty.zip",
      sources: ["empty-archive-source"],
    }, context) as { entries: number };
    expect(emptyResult.entries).toBe(1);
    expect(unzipSync(readFileSync(join(tmp, "exports", "empty.zip")))["empty-archive-source/"])
      .toBeDefined();
  });

  it("counts synthetic empty roots in the aggregate ZIP entry limit", async () => {
    const archive = tools.find((tool) => tool.name === "create_archive")!;
    mkdirSync(join(tmp, "cap-source"));
    for (let index = 0; index < 255; index += 1) {
      writeFileSync(join(tmp, "cap-source", `${index}.txt`), "");
    }
    mkdirSync(join(tmp, "cap-empty-a"));
    mkdirSync(join(tmp, "cap-empty-b"));

    await expect(archive.execute!({
      path: "exports/too-many.zip",
      sources: ["cap-source", "cap-empty-a", "cap-empty-b"],
    }, context)).rejects.toThrow("workspace_tree_too_many_entries");
    expect(existsSync(join(tmp, "exports", "too-many.zip"))).toBe(false);
  });

  it("creates real DOCX, XLSX, and CSV documents from bounded structured input", async () => {
    const document = tools.find((tool) => tool.name === "create_document")!;
    const spreadsheet = tools.find((tool) => tool.name === "create_spreadsheet")!;

    await document.execute!({
      path: "exports/brief.docx",
      title: "Project Brief",
      paragraphs: ["First paragraph", "Second paragraph"],
    }, context);
    const docx = unzipSync(readFileSync(join(tmp, "exports", "brief.docx")));
    expect(Buffer.from(docx["word/document.xml"]!).toString("utf-8")).toContain("Project Brief");

    await spreadsheet.execute!({
      path: "exports/data.xlsx",
      format: "xlsx",
      sheets: [{ name: "Data", rows: [["Name", "Value"], ["alpha", 42]] }],
    }, context);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(readFileSync(join(tmp, "exports", "data.xlsx")) as never);
    expect(workbook.getWorksheet("Data")?.getCell("B2").value).toBe(42);

    await spreadsheet.execute!({
      path: "exports/data.csv",
      format: "csv",
      sheets: [{ name: "Data", rows: [["Name", "Value"], ["alpha", 42]] }],
    }, context);
    expect(readFileSync(join(tmp, "exports", "data.csv"), "utf-8")).toBe("Name,Value\r\nalpha,42\r\n");
  });

  it("rejects output collisions, archive secret paths, and spreadsheet formulas before execution", async () => {
    const createDirectory = tools.find((tool) => tool.name === "create_directory")!;
    const archive = tools.find((tool) => tool.name === "create_archive")!;
    const document = tools.find((tool) => tool.name === "create_document")!;
    const spreadsheet = tools.find((tool) => tool.name === "create_spreadsheet")!;
    writeFileSync(join(tmp, "collision.txt"), "keep");

    await expect(createDirectory.execute!({ path: "collision.txt" }, context)).rejects.toThrow();
    expect(archive.validateInput?.({ path: "secret.zip", sources: [".env"] }))
      .toContain("workspace_secret_path_denied");
    expect(spreadsheet.validateInput?.({
      path: "formula.csv",
      format: "csv",
      sheets: [{ name: "Data", rows: [["\t=HYPERLINK(\"bad\")"]] }],
    })).toContain("spreadsheet_formula_denied");
    expect(document.validateInput?.({
      path: "huge.docx",
      title: "界".repeat(400_000),
      paragraphs: [],
    })).toContain("document_too_large");
    expect(spreadsheet.validateInput?.({
      path: "huge.xlsx",
      format: "xlsx",
      sheets: [{ name: "Data", rows: [["x".repeat(5 * 1024 * 1024 + 1)]] }],
    })).toContain("spreadsheet_too_large");
  });

  it("run_shell executes an allowlisted executable with argv preserved", async () => {
    const shellTool = tools.find((t) => t.name === "run_shell")!;
    expect(shellTool).toBeDefined();
    expect(shellTool).toMatchObject({ risk: "destructive", capability: "shell", generation: 2 });

    expect(shellTool.validateInput?.({ executable: "echo", argv: ["hello test"] })).toEqual([]);
    const result = (await shellTool.execute!({ executable: "echo", argv: ["hello test"] }, context)) as any;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello test");
    expect(result).toMatchObject({
      executable: "echo",
      argv: ["hello test"],
      stderr: "",
      timedOut: false,
      cancelled: false,
    });
  });

  it("run_shell rejects disallowed executables and shell metacharacter smuggling before approval", () => {
    const shellTool = tools.find((t) => t.name === "run_shell")!;
    expect(shellTool.validateInput?.({ executable: "/bin/bash", argv: ["-c", "echo"] }))
      .toContain("shell_executable_not_allowed");
    expect(shellTool.validateInput?.({ executable: "git", argv: ["status; rm", "-rf"] }))
      .toContain("shell_metacharacter_denied");
    expect(shellTool.validateInput?.({ executable: "echo", argv: ["hello|cat"] }))
      .toContain("shell_metacharacter_denied");
    expect(shellTool.validateInput?.({ executable: "echo", argv: ["sk-abcdefgh"] }))
      .toContain("shell_credential_argument_denied");
    expect(shellTool.validateInput?.({ executable: "echo", argv: ["--api-key=value"] }))
      .toContain("shell_credential_argument_denied");
    expect(shellTool.validateInput?.({ executable: "echo", argv: ["password=hunter2"] }))
      .toContain("shell_credential_argument_denied");
    expect(shellTool.validateInput?.({ executable: "cat", argv: ["/etc/passwd"] }))
      .toContain("shell_argument_path_outside");
    expect(shellTool.validateInput?.({ executable: "cat", argv: ["../outside"] }))
      .toContain("shell_argument_path_outside");
    expect(shellTool.validateInput?.({ executable: "git", argv: ["--git-dir=/tmp/outside", "status"] }))
      .toContain("shell_argument_path_outside");
    expect(shellTool.validateInput?.({ executable: "git", argv: ["-C../outside", "status"] }))
      .toContain("shell_argument_path_outside");
    expect(shellTool.validateInput?.({ executable: "grep", argv: ["SECRET", ".env"] }))
      .toContain("workspace_secret_path_denied");
  });

  it("run_shell captures stderr on failure", async () => {
    const shellTool = tools.find((t) => t.name === "run_shell")!;
    const result = (await shellTool.execute!({ executable: "git", argv: ["rev-parse", "missing-ref-xyz"] }, context)) as any;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });
});
