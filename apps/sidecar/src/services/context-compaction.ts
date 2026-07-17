import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export type DiscussionContextTurn = { agentId: string; agentName: string; round: number; content: string };
export type CompactionResult = { turns: DiscussionContextTurn[]; compacted: boolean; created: boolean; sourceHash?: string; coveredFrom?: number; coveredTo?: number };

export class ContextCompactionService {
  constructor(private readonly db: Database, private readonly maxChars = 60_000) {}

  compact(taskId: string, turns: DiscussionContextTurn[]): CompactionResult {
    const size = turns.reduce((sum, turn) => sum + turn.content.length, 0);
    if (size <= this.maxChars || turns.length < 3) return { turns, compacted: false, created: false };
    const keepCount = Math.min(8, Math.max(1, Math.floor(turns.length / 3)));
    const covered = turns.slice(0, -keepCount);
    const rawRemainder = turns.slice(-keepCount);
    const sourceHash = createHash("sha256").update(JSON.stringify(covered)).digest("hex");
    const existing = this.db.query<{ summary: string }, [string, string]>("SELECT summary FROM multi_compactions WHERE task_id = ? AND source_hash = ?").get(taskId, sourceHash);
    const budgetPerTurn = Math.max(120, Math.floor((this.maxChars * 0.35) / covered.length));
    const summary = existing?.summary ?? covered.map((turn) => {
      const content = turn.content.length <= budgetPerTurn ? turn.content : `${turn.content.slice(0, budgetPerTurn - 1)}…`;
      return `[Round ${turn.round} · ${turn.agentName} (${turn.agentId})]\n${content}`;
    }).join("\n\n");
    const recentBudget = Math.max(160, Math.floor((this.maxChars * 0.55) / rawRemainder.length));
    const remainder = rawRemainder.map((turn) => ({ ...turn, content: turn.content.length <= recentBudget ? turn.content : `${turn.content.slice(0, recentBudget - 1)}…` }));
    if (!existing) this.db.query("INSERT INTO multi_compactions (id, task_id, covered_from, covered_to, source_hash, summary, created_at) VALUES (?, ?, 0, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), taskId, covered.length - 1, sourceHash, summary, new Date().toISOString());
    return {
      turns: [{ agentId: "context-checkpoint", agentName: "Context checkpoint", round: 0, content: summary }, ...remainder],
      compacted: true, created: !existing, sourceHash, coveredFrom: 0, coveredTo: covered.length - 1,
    };
  }
}
