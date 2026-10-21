import { createHash } from "node:crypto";
export function collaborationOperationId(
  runId: string,
  tool: string,
  operationKey: unknown
) {
  if (
    typeof operationKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      operationKey
    )
  )
    throw new Error("本次草稿准备需要稳定的 UUID operationKey，重试时必须复用");
  const bytes = createHash("sha256")
    .update(`${runId}\0${tool}\0${operationKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
