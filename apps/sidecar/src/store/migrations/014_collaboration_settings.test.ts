import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrations";
import { migrations } from "./index";

describe("014 collaboration settings migration", () => {
  it("converts legacy Boss and approval fields without changing room identity", () => {
    const db = new Database(":memory:");
    expect(runMigrations(db, migrations.slice(0, -1))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    db.query(`
      INSERT INTO workspaces
        (id, canonical_path, display_path, identity_hash, label, created_at,
         last_opened_at)
      VALUES ('workspace', '/tmp/workspace', '/tmp/workspace', 'hash',
        'Workspace', 'now', 'now')
    `).run();
    db.query(`
      INSERT INTO sessions
        (id, title, mode, kind, workspace_id, primary_agent_id,
         collaboration_json, status,
         created_at, updated_at)
      VALUES ('room', 'Room', 'multi_agent', 'cowork', 'workspace', 'boss', ?, 'idle',
        'now', 'now')
    `).run(JSON.stringify({
      discussionMode: "debate",
      collaborationMode: "agent_directed_multi_agent",
      boss: { enabled: true, bossAgentId: "boss" },
      approvalMode: "designated_reviewer",
      designatedReviewerId: "reviewer",
    }));
    for (const [position, agentId] of ["boss", "reviewer"].entries()) {
      db.query(`
        INSERT INTO session_agents
          (session_id, agent_id, snapshot_json, position, execution_eligible)
        VALUES ('room', ?, '{}', ?, 1)
      `).run(agentId, position);
    }

    expect(runMigrations(db, migrations)).toEqual([14]);

    const row = db.query<{ collaboration_json: string }, []>(
      "SELECT collaboration_json FROM sessions WHERE id = 'room'",
    ).get()!;
    expect(JSON.parse(row.collaboration_json)).toMatchObject({
      strategy: "team",
      assignment: { coordinatorAgentId: "boss" },
      discussion: {
        enabled: true,
        mode: "debate",
        speakerOrder: ["boss", "reviewer"],
        summaryAgentId: "boss",
      },
      planConfirmation: {
        mode: "reviewer",
        reviewerAgentId: "reviewer",
      },
    });
  });
});
