import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outputDir = path.resolve(process.argv[2] || process.env.EMPLOYEE_AGENT_RUNTIME_CONFIG_DIR || "../employee-agent-runtime-config");
const privatePath = path.join(outputDir, "enterprise-mcp-signing-private.pem");
const publicPath = path.join(outputDir, "enterprise-mcp-signing-public.pem");

mkdirSync(outputDir, { recursive: true });
if (existsSync(privatePath) || existsSync(publicPath)) {
  throw new Error(`Refusing to replace an existing enterprise MCP key pair in ${outputDir}`);
}

const pair = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
writeFileSync(privatePath, pair.privateKey, { mode: 0o600 });
writeFileSync(publicPath, pair.publicKey, { mode: 0o644 });
chmodSync(privatePath, 0o600);
chmodSync(publicPath, 0o644);
console.log(JSON.stringify({ privatePath, publicPath }, null, 2));
