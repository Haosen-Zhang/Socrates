import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { EventStore } from "./event-store";

function setup() {
  const db = openDb(":memory:");
  db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("session-1", "Test", "chat", "idle", "now", "now");
  return { db, store: new EventStore(db) };
}

describe("EventStore", () => {
  it("assigns strict sequence numbers and replays after a cursor", () => {
    const { store } = setup();
    for (let index = 1; index <= 20; index += 1) {
      store.append({ eventId: `e-${index}`, sessionId: "session-1", type: "delta.checkpoint", payload: { index } });
    }
    const replay = store.listAfter("session-1", 7);
    expect(replay).toHaveLength(13);
    expect(replay[0]?.seq).toBe(8);
    expect(replay.at(-1)?.seq).toBe(20);
  });

  it("deduplicates event ids without re-running the projection", () => {
    const { store } = setup();
    let projections = 0;
    const first = store.append({ eventId: "same", sessionId: "session-1", type: "x", payload: {} }, () => { projections += 1; });
    const duplicate = store.append({ eventId: "same", sessionId: "session-1", type: "x", payload: {} }, () => { projections += 1; });
    expect(duplicate).toEqual(first);
    expect(projections).toBe(1);
  });

  it("does not commit an event when its projection fails", () => {
    const { store } = setup();
    expect(() => store.append({ eventId: "failed", sessionId: "session-1", type: "x", payload: {} }, () => {
      throw new Error("projection_failed");
    })).toThrow("projection_failed");
    expect(store.listAfter("session-1", 0)).toEqual([]);
  });
});
