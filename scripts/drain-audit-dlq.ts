import "dotenv/config";
import { drainAuditDlq } from "../server/_core/audit-ledger";

const maxEvents = Number(process.argv.find((arg) => arg.startsWith("--max="))?.split("=", 2)[1] || 10_000);
const result = await drainAuditDlq({ maxEvents });
console.log(JSON.stringify(result, null, 2));
process.exit(result.failed > 0 || result.invalid > 0 ? 1 : 0);
