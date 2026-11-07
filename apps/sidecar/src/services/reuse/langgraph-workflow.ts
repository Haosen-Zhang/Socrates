import { StateGraph, Annotation, START, END, Command, interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";

export const WORKFLOW_VERSION = "cost-aware-compatibility-v1";
const State = Annotation.Root({
  request: Annotation<string>(), commandId: Annotation<string>(), approved: Annotation<boolean>(), version: Annotation<string>(),
});

/** Compatibility workflow, deliberately not registered as a second owner of production Chat/Work tasks. */
export function buildReuseWorkflow(checkpointer: BaseCheckpointSaver, executeTask: (request: string, signal?: AbortSignal) => Promise<string>) {
  return new StateGraph(State)
    .addNode("execute_service", async (state, config) => {
      config.signal?.throwIfAborted();
      return { commandId: await executeTask(state.request, config.signal), version: WORKFLOW_VERSION };
    })
    .addNode("human_review", () => ({ approved: interrupt({ kind: "confirm_result", version: WORKFLOW_VERSION }) === true }))
    .addEdge(START, "execute_service").addEdge("execute_service", "human_review").addEdge("human_review", END)
    .compile({ checkpointer });
}

export const resumeReuseWorkflow = () => new Command({ resume: true });
