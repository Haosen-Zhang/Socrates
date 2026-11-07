import type { Database } from "bun:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, TASKS, WRITES_IDX_MAP, type Checkpoint, type CheckpointTuple, type CheckpointMetadata,
  type CheckpointListOptions, type PendingWrite, type ChannelVersions } from "@langchain/langgraph-checkpoint";

interface CheckpointRow {
  thread_id: string; checkpoint_ns: string; checkpoint_id: string; parent_id: string | null;
  type: string; checkpoint: Uint8Array; metadata_type: string; metadata: Uint8Array;
}
interface WriteRow { task_id: string; channel: string; type: string; value: Uint8Array }

/** Bun storage adapter only; LangGraph owns graph execution and serialization. No business facts live here. */
export class BunSqliteCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly db: Database) {
    super();
    db.exec(`CREATE TABLE IF NOT EXISTS lg_checkpoints (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, parent_id TEXT,
      type TEXT NOT NULL, checkpoint BLOB NOT NULL, metadata_type TEXT NOT NULL, metadata BLOB NOT NULL,
      PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id));
      CREATE TABLE IF NOT EXISTS lg_writes (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL,
      idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL, value BLOB NOT NULL,
      PRIMARY KEY(thread_id,checkpoint_ns,checkpoint_id,task_id,idx));`);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (typeof thread_id !== "string") return undefined;
    const row = checkpoint_id
      ? this.db.query<CheckpointRow, [string, string, string]>("SELECT * FROM lg_checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?").get(thread_id, checkpoint_ns, checkpoint_id)
      : this.db.query<CheckpointRow, [string, string]>("SELECT * FROM lg_checkpoints WHERE thread_id=? AND checkpoint_ns=? ORDER BY checkpoint_id DESC LIMIT 1").get(thread_id, checkpoint_ns);
    if (!row) return undefined;
    const writes = this.db.query<WriteRow, [string, string, string]>("SELECT task_id,channel,type,value FROM lg_writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? ORDER BY task_id,idx")
      .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id);
    const pendingWrites: NonNullable<CheckpointTuple["pendingWrites"]> = await Promise.all(writes.map(async write =>
      [write.task_id, write.channel, await this.serde.loadsTyped(write.type, write.value)] as [string, string, unknown]));
    const sends = row.parent_id ? this.db.query<WriteRow, [string, string, string, string]>("SELECT task_id,channel,type,value FROM lg_writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? AND channel=? ORDER BY task_id,idx")
      .all(row.thread_id, row.checkpoint_ns, row.parent_id, TASKS) : [];
    const checkpoint = await this.serde.loadsTyped(row.type, row.checkpoint) as Checkpoint;
    checkpoint.pending_sends = await Promise.all(sends.map(send => this.serde.loadsTyped(send.type, send.value)));
    const conf = (id: string) => ({ configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: id } });
    return { config: conf(row.checkpoint_id), checkpoint,
      metadata: await this.serde.loadsTyped(row.metadata_type, row.metadata) as CheckpointMetadata,
      ...(row.parent_id ? { parentConfig: conf(row.parent_id) } : {}), pendingWrites };
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { thread_id, checkpoint_ns } = config.configurable ?? {};
    if (typeof thread_id !== "string") throw new Error("checkpoint_thread_required");
    const rows = this.db.query<Pick<CheckpointRow, "checkpoint_id" | "checkpoint_ns">, [string]>("SELECT checkpoint_id,checkpoint_ns FROM lg_checkpoints WHERE thread_id=? ORDER BY checkpoint_id DESC").all(thread_id);
    let yielded = 0;
    for (const row of rows) {
      if (checkpoint_ns !== undefined && row.checkpoint_ns !== checkpoint_ns) continue;
      if (config.configurable?.checkpoint_id && row.checkpoint_id !== config.configurable.checkpoint_id) continue;
      if (options?.before?.configurable?.checkpoint_id && row.checkpoint_id >= options.before.configurable.checkpoint_id) continue;
      if (options?.limit !== undefined && yielded >= options.limit) break;
      const tuple = await this.getTuple({ configurable: { thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } });
      if (!tuple) continue;
      // No SQL identifiers or JSON paths are constructed from caller-supplied filter keys.
      if (options?.filter && !Object.entries(options.filter).every(([key, value]) => (tuple.metadata as Record<string, unknown> | undefined)?.[key] === value)) continue;
      yield tuple; yielded++;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _versions: ChannelVersions): Promise<RunnableConfig> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (typeof thread_id !== "string") throw new Error("checkpoint_thread_required");
    const { pending_sends: _pending, ...data } = checkpoint;
    const [type, bytes] = this.serde.dumpsTyped(data);
    const [metadataType, metadataBytes] = this.serde.dumpsTyped(metadata);
    this.db.query(`INSERT OR REPLACE INTO lg_checkpoints (thread_id,checkpoint_ns,checkpoint_id,parent_id,type,checkpoint,metadata_type,metadata)
      VALUES (?,?,?,?,?,?,?,?)`).run(thread_id, checkpoint_ns, checkpoint.id, checkpoint_id ?? null, type, bytes, metadataType, metadataBytes);
    return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    if (typeof thread_id !== "string" || typeof checkpoint_id !== "string") throw new Error("checkpoint_identity_required");
    const prepared = writes.map(([channel, value], index) => ({ channel, index: WRITES_IDX_MAP[channel] ?? index, serialized: this.serde.dumpsTyped(value) }));
    this.db.transaction(() => {
      for (const write of prepared) {
        const [type, bytes] = write.serialized;
        const clause = write.index < 0 ? "OR REPLACE" : "OR IGNORE";
        this.db.query(`INSERT ${clause} INTO lg_writes (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,value) VALUES (?,?,?,?,?,?,?,?)`)
          .run(thread_id, checkpoint_ns, checkpoint_id, taskId, write.index, write.channel, type, bytes);
      }
    })();
  }
}
