import { expect, test } from "bun:test";
import { createAiSdkNativeStream } from "./native-agent-runtime";

test("every native sample sends the executable output cap to the provider", async () => {
  const caps: unknown[] = [];
  const stream = createAiSdkNativeStream({} as never, ((options) => {
    caps.push(options.maxOutputTokens);
    return {
      fullStream: (async function* () { yield { type: "text-delta", text: "done" }; })(),
      responseMessages: Promise.resolve([]), steps: Promise.resolve([{}]),
    } as never;
  }) as typeof import("ai").streamText, { maxOutputTokens: 123 });
  for await (const _event of stream({ prompt: "work", messages: [], tools: {}, maxSteps: 1,
    requestApproval: async () => ({ approved: false }) })) { /* drain the real sampler */ }
  expect(caps).toEqual([123]);
});
