/**
 * LangGraph Agent Runtime — Socrates Phase 1
 *
 * 薄封装：LangGraph 的 StateGraph 作为 Agent loop 引擎。
 * Socrates 的状态机类型和 protocol 作为外层。
 *
 * 依赖：@langchain/langgraph, @langchain/core
 * 仅引入 apps/sidecar，不进 packages/core。
 *
 * ## Persistence（Ticket 007）
 *
 * 方案 A（推荐）：使用 LangGraph 内置 SqliteSaver
 *   - 来自 @langchain/langgraph-checkpoint-sqlite
 *   - 与 Socrates SQLite 使用同一数据库文件，不同表（langgraph_checkpoints）
 *   - 稳定格式，原生支持 replay
 *   - LangGraph thread_id 与 Socrates agent_runs.thread_id 一一对应
 *
 * 方案 B（备选）：自定义 BaseCheckpointSaver → Socrates runtime_events 表
 *   - 仅在方案 A 不可行时采用
 *
 * 集成点：构造函数接受可选 checkpointer，传递给 graph.compile({ checkpointer })
 */

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type {
  AgentRuntime,
  MessagePart,
  RuntimeEvent,
  NormalizedUsage,
} from "@socrates/core";
import {
  reduceRunState,
  reduceAgentState,
  reduceTurnState,
  reduceToolState,
  type RunState,
  type AgentState,
  type TurnState,
  type ToolState,
} from "@socrates/core";

// ─── Types ─────────────────────────────────────────────────

export interface LangGraphAgentRuntimeInput {
  sessionId: string;
  agentId: string;
  workspaceId?: string;
  system?: string;
  /** LangGraph checkpointer for persistence/replay (Ticket 007).
   *  Passing a SqliteSaver enables checkpoint-based SSE replay. */
  checkpointer?: import("@langchain/langgraph").BaseCheckpointSaver;
  /** Callback to invoke the model via Vercel AI SDK (or any provider) */
  modelInvoker: (input: {
    messages: BaseMessage[];
    system?: string;
    signal?: AbortSignal;
  }) => AsyncIterable<{
    type: "text_delta"; text: string;
  } | {
    type: "tool_call"; callId: string; name: string; input: unknown;
  } | {
    type: "usage"; usage: NormalizedUsage;
  }>;
  /** Callback to execute a tool and return structured result */
  toolExecutor: (input: {
    callId: string;
    name: string;
    input: unknown;
    signal?: AbortSignal;
  }) => Promise<{ output: unknown; isError: boolean }>;
  /** Check if a tool needs approval */
  toolNeedsApproval: (toolName: string) => boolean;
}

// ─── LangGraph State ───────────────────────────────────────

const AgentGraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (existing, incoming) => existing.concat(incoming),
    default: () => [],
  }),
  runId: Annotation<string>(),
  agentId: Annotation<string>(),
  turnId: Annotation<string>(),
  runState: Annotation<RunState>(),
  agentState: Annotation<AgentState>(),
  turnState: Annotation<TurnState>(),
  /** Pending tool calls that need approval */
  pendingApprovals: Annotation<Array<{ callId: string; name: string; input: unknown }>>({
    reducer: (_, incoming) => incoming,
    default: () => [],
  }),
  /** Tool results to write back as messages */
  toolResults: Annotation<Array<{ callId: string; output: unknown; isError: boolean }>>({
    reducer: (existing, incoming) => existing.concat(incoming),
    default: () => [],
  }),
  abortSignal: Annotation<AbortSignal | undefined>({
    reducer: (_, incoming) => incoming,
    default: () => undefined,
  }),
});

// ─── Runtime Implementation ────────────────────────────────

export class LangGraphAgentRuntime implements AgentRuntime {
  readonly kind = "langgraph_socrates";
  readonly capabilities: import("@socrates/core").ModelCapabilities = {
    textInput: true,
    imageInput: true,
    fileInput: true,
    toolCalling: true,
    streaming: true,
    reasoningEfforts: "unknown",
    runtimeKinds: ["langgraph_socrates"],
  };

  private compiled: ReturnType<typeof this.buildGraph> | null = null;
  private currentMessages: BaseMessage[] = [];
  private runState_: RunState = "created";
  private agentState_: AgentState = "ready";
  private turnState_: TurnState = "queued";
  private sequence = 0;

  constructor(private readonly input: LangGraphAgentRuntimeInput) {}

  async open(_opts: { sessionId: string; workspaceId?: string }): Promise<void> {
    this.runState_ = "created";
    this.agentState_ = "ready";
  }

  async *start(input: { prompt: string; parts?: MessagePart[]; signal?: AbortSignal }): AsyncIterable<RuntimeEvent> {
    if (this.runState_ !== "created") throw new Error("langgraph_runtime_already_started");

    const runId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    this.sequence = 0;

    // Transition to running
    this.runState_ = reduceRunState("created", { type: "start" });
    this.agentState_ = reduceAgentState("ready", { type: "run_started" });
    this.turnState_ = reduceTurnState("queued", { type: "prepare" });

    yield this.makeEvent({ type: "run.started", runId, agentId: this.input.agentId, turnId });

    // Build context message
    const contextBlocks = this.buildContextBlocks(input.parts ?? []);
    const userText = contextBlocks.length
      ? `${input.prompt}\n\n${contextBlocks.join("\n\n")}`
      : input.prompt;

    const userMessage = new HumanMessage(userText);
    this.currentMessages = [userMessage];

    // Build and compile the graph
    const graph = this.buildGraph(runId, turnId, input.signal);
    this.compiled = graph;

    try {
      const initialState = {
        messages: this.currentMessages,
        runId,
        agentId: this.input.agentId,
        turnId,
        runState: this.runState_,
        agentState: this.agentState_,
        turnState: this.turnState_,
        pendingApprovals: [],
        toolResults: [],
        abortSignal: input.signal,
      };

      const stream = await graph.stream(initialState, {
        streamMode: "updates" as const,
      });

      for await (const chunk of stream) {
        // LangGraph yields updates per node — map to Socrates RuntimeEvent
        for (const [nodeName, update] of Object.entries(chunk)) {
          const typed = update as Record<string, unknown>;

          if (nodeName === "model" && typed.messages) {
            // Model output: emit deltas
            const msgs = typed.messages as BaseMessage[];
            for (const msg of msgs) {
              if (msg instanceof AIMessage) {
                const text = typeof msg.content === "string" ? msg.content : "";
                if (text) {
                  yield this.makeEvent({ type: "assistant.delta", text, runId, agentId: this.input.agentId, turnId });
                }
                for (const tc of msg.tool_calls ?? []) {
                  yield this.makeEvent({
                    type: "tool.proposed",
                    toolCallId: tc.id!,
                    name: tc.name,
                    input: tc.args,
                    runId,
                    agentId: this.input.agentId,
                    turnId,
                  });
                }
              }
            }
          }

          if (nodeName === "tools" && typed.toolResults) {
            const results = typed.toolResults as Array<{ callId: string; output: unknown; isError: boolean }>;
            for (const r of results) {
              yield this.makeEvent({
                type: r.isError ? "tool.failed" : "tool.completed",
                toolCallId: r.callId,
                output: r.output,
                runId,
                agentId: this.input.agentId,
                turnId,
              });
            }
          }

          // Track state from graph
          if (typed.runState) this.runState_ = typed.runState as RunState;
          if (typed.agentState) this.agentState_ = typed.agentState as AgentState;
          if (typed.turnState) this.turnState_ = typed.turnState as TurnState;
        }
      }

      // Completion
      this.runState_ = reduceRunState(this.runState_, { type: "complete" });
      this.agentState_ = reduceAgentState(this.agentState_, { type: "complete" });
      this.turnState_ = reduceTurnState(this.turnState_, { type: "complete" });
      yield this.makeEvent({ type: "run.completed", runId, agentId: this.input.agentId, turnId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (input.signal?.aborted) {
        this.runState_ = reduceRunState(this.runState_, { type: "cancel" });
        yield this.makeEvent({ type: "run.cancelled", runId, agentId: this.input.agentId, turnId, error: message });
      } else {
        this.runState_ = reduceRunState(this.runState_, { type: "fail", reason: message });
        this.agentState_ = reduceAgentState(this.agentState_, { type: "fail", reason: message });
        yield this.makeEvent({ type: "run.failed", runId, agentId: this.input.agentId, turnId, error: message });
      }
    }
  }

  async answerApproval(requestId: string, decision: "allow_once" | "allow_session" | "deny"): Promise<void> {
    // Handled externally by SingleAgentRunner / ApprovalManager
    throw new Error("langgraph_approval_delegated_to_runner");
  }

  async interrupt(): Promise<void> {
    this.runState_ = reduceRunState(this.runState_, { type: "cancel" });
  }

  async close(): Promise<void> {
    this.compiled = null;
    this.currentMessages = [];
  }

  // ─── Graph Definition ────────────────────────────────

  private buildGraph(runId: string, turnId: string, signal?: AbortSignal) {
    const modelInvoker = this.input.modelInvoker;
    const toolExecutor = this.input.toolExecutor;
    const toolNeedsApproval = this.input.toolNeedsApproval;
    const agentId = this.input.agentId;

    const prepareContextNode = async (state: typeof AgentGraphState.State): Promise<Partial<typeof AgentGraphState.State>> => {
      const nextTurn = reduceTurnState(state.turnState, { type: "sample" });
      return {
        turnState: nextTurn,
        agentState: reduceAgentState(state.agentState, { type: "turn_started" }),
      };
    };

    const callModelNode = async (state: typeof AgentGraphState.State): Promise<Partial<typeof AgentGraphState.State>> => {
      const nextTurn = reduceTurnState(state.turnState, { type: "sample" });
      const modelResponse: BaseMessage[] = [];
      const pendingApprovals: Array<{ callId: string; name: string; input: unknown }> = [];
      let hasToolCalls = false;
      let needsApproval = false;

      for await (const event of modelInvoker({
        messages: state.messages,
        system: this.input.system,
        signal: state.abortSignal,
      })) {
        if (event.type === "text_delta") {
          // Accumulate text; will be emitted as stream events by the outer loop
        } else if (event.type === "tool_call") {
          hasToolCalls = true;
          if (toolNeedsApproval(event.name)) {
            needsApproval = true;
            pendingApprovals.push({ callId: event.callId, name: event.name, input: event.input });
          } else {
            // Execute immediately
            const result = await toolExecutor({
              callId: event.callId,
              name: event.name,
              input: event.input,
              signal: state.abortSignal,
            });
            const toolMsg = new ToolMessage({
              content: JSON.stringify(result.output),
              tool_call_id: event.callId,
            });
            modelResponse.push(toolMsg);
          }
        }
      }

      // Add AIMessage placeholder for tracking
      const aiMsg = new AIMessage({ content: "", tool_calls: pendingApprovals.map(a => ({ id: a.callId, name: a.name, args: a.input as Record<string, unknown> })) });
      modelResponse.unshift(aiMsg);

      const nextTurn2 = reduceTurnState(nextTurn, {
        type: "model_response",
        hasToolCalls,
        needsApproval,
      });

      return {
        messages: modelResponse,
        turnState: nextTurn2,
        pendingApprovals,
        agentState: needsApproval
          ? reduceAgentState(state.agentState, { type: "awaiting_approval" })
          : state.agentState,
      };
    };

    const executeToolsNode = async (state: typeof AgentGraphState.State): Promise<Partial<typeof AgentGraphState.State>> => {
      const nextTurn = reduceTurnState(state.turnState, { type: "approval_settled" });
      const nextTurn2 = reduceTurnState(nextTurn, { type: "approval_settled" }); // → executing_tools
      const results: Array<{ callId: string; output: unknown; isError: boolean }> = [];

      for (const pending of state.pendingApprovals) {
        try {
          const result = await toolExecutor({
            callId: pending.callId,
            name: pending.name,
            input: pending.input,
            signal: state.abortSignal,
          });
          results.push({ callId: pending.callId, output: result.output, isError: result.isError });
        } catch (err) {
          results.push({
            callId: pending.callId,
            output: err instanceof Error ? err.message : String(err),
            isError: true,
          });
        }
      }

      const toolMessages = results.map(r =>
        new ToolMessage({
          content: JSON.stringify(r.output),
          tool_call_id: r.callId,
        })
      );

      return {
        toolResults: results,
        messages: toolMessages,
        turnState: reduceTurnState(nextTurn2, { type: "tools_completed" }),
        pendingApprovals: [],
        agentState: reduceAgentState(state.agentState, { type: "approval_resolved" }),
      };
    };

    const routeAfterModel = (state: typeof AgentGraphState.State): string => {
      if (state.turnState === "awaiting_tool_approval") return "tools";
      if (state.turnState === "executing_tools") return "tools";
      return "finalize";
    };

    const finalizeNode = async (state: typeof AgentGraphState.State): Promise<Partial<typeof AgentGraphState.State>> => {
      return {
        turnState: reduceTurnState(state.turnState, { type: "finalize" }),
        agentState: reduceAgentState(state.agentState, { type: "turn_completed" }),
      };
    };

    const graph = new StateGraph(AgentGraphState)
      .addNode("prepare", prepareContextNode)
      .addNode("model", callModelNode)
      .addNode("tools", executeToolsNode)
      .addNode("finalize", finalizeNode)
      .addEdge(START, "prepare")
      .addEdge("prepare", "model")
      .addConditionalEdges("model", routeAfterModel, {
        tools: "tools",
        finalize: "finalize",
      })
      .addEdge("tools", "model")
      .addEdge("finalize", END);

    return graph.compile({
      checkpointer: this.input.checkpointer,
    });
  }

  // ─── Helpers ──────────────────────────────────────────

  private buildContextBlocks(parts: MessagePart[]): string[] {
    return parts.map((part) => {
      if (part.type === "text") return part.text;
      return `[${part.type}: ${JSON.stringify(part)}]`;
    });
  }

  private makeEvent(event: {
    type: string;
    runId: string;
    agentId: string;
    turnId: string;
    text?: string;
    toolCallId?: string;
    name?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
  }): RuntimeEvent {
    this.sequence++;
    return {
      type: "extension",
      name: event.type,
      payload: {
        runId: event.runId,
        agentId: event.agentId,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        eventId: `${event.runId}:${this.sequence}`,
        sequence: this.sequence,
        timestamp: new Date().toISOString(),
        protocolVersion: "1",
        text: event.text,
        name: event.name,
        input: event.input,
        output: event.output,
        error: event.error,
      },
    };
  }
}
