import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";
const pendingApproval = new Map<string | number, string | number>();
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as { id?: string | number; method?: string; params?: unknown; result?: unknown };
  if (message.id !== undefined && message.method === undefined && pendingApproval.has(message.id)) {
    const original = pendingApproval.get(message.id)!;
    pendingApproval.delete(message.id);
    send({ id: original, result: { approved: message.result } });
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  if (mode === "crash") process.exit(7);
  if (mode === "hang") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake/1", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
  } else if (message.method === "echo") {
    send({ method: "fake/progress", params: { value: 1 } });
    send({ id: message.id, result: message.params });
  } else if (message.method === "approval") {
    pendingApproval.set("server-1", message.id!);
    send({ id: "server-1", method: "item/commandExecution/requestApproval", params: { command: "pwd" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1" }, cwd: "/tmp", model: "fake", modelProvider: "fake", sandbox: { type: "readOnly" }, approvalPolicy: "on-request", approvalsReviewer: "user" } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } });
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
