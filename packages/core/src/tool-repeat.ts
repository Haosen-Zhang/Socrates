// Adapted from DeepSeek Harness repeat-tool-reminder/src/index.ts at 8bd0733.
// Copyright (c) 2026 DeepSeek, MIT; see third-party/DeepSeek-Harness-LICENSE.
export function repeatToolReminder(name: string, count: number): string | undefined {
  if (![3, 5, 8].includes(count)) return undefined;
  if (count === 3) return "You are repeating the exact same tool call with identical arguments. "
    + "Carefully analyze the previous result before calling again: if the task is "
    + "not complete, try a different approach or different arguments instead of repeating the call.";
  return `Repeated tool call detected: ${name}, consecutive_calls: ${count}. `
    + "Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.";
}
