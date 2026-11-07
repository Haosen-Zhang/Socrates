import { openDb } from "../../db";
import { BudgetLedger } from "../cost-ledger";
const [path, invocationId] = process.argv.slice(2);
if (!path || !invocationId) throw new Error("fixture_arguments_required");
const db = openDb(path); db.exec("PRAGMA busy_timeout=5000");
try {
  new BudgetLedger(db).reserve(invocationId, "task", "600000000000", { strictEligible: true });
  process.stdout.write(JSON.stringify({ accepted: true }));
} catch (error) { process.stdout.write(JSON.stringify({ accepted: false, error: error instanceof Error ? error.message : String(error) })); }
finally { db.close(); }
