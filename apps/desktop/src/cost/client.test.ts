import { afterEach, expect, it } from "bun:test";
import { costRequest, isDefiniteCostRejection } from "./client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("distinguishes a definite revision rejection from an uncertain transport failure", async () => {
  globalThis.fetch = (async () => Response.json({ error: "cost_budget_revision_conflict" }, { status: 409 })) as unknown as typeof fetch;
  const rejected = await costRequest({ port: 1, token: "fixture" }, "/tasks/task/increase", {}).catch(error => error);
  if (!(rejected instanceof Error)) throw new Error("expected a definite API rejection");
  expect(rejected.message).toBe("cost_budget_revision_conflict");
  expect(isDefiniteCostRejection(rejected)).toBe(true);
  globalThis.fetch = (async () => { throw new Error("response lost after commit"); }) as unknown as typeof fetch;
  const uncertain = await costRequest({ port: 1, token: "fixture" }, "/tasks/task/increase", {}).catch(error => error);
  expect(isDefiniteCostRejection(uncertain)).toBe(false);
});
