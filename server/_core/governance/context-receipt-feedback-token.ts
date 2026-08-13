import { createHmac, timingSafeEqual } from "node:crypto";

type MemoryFeedbackBinding = {
  userId: number;
  adoptId: string;
  receiptId: string;
  memoryIds: string[];
  expiresAt: string;
};

function signingSecret(): string {
  return String(process.env.JWT_SECRET || "").trim();
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createContextReceiptMemoryFeedbackToken(input: {
  userId: number;
  adoptId: string;
  receiptId: string;
  memoryIds: string[];
  createdAt: string;
  ttlDays?: number;
}): { token: string; expiresAt: string } | null {
  const secret = signingSecret();
  if (!secret || input.memoryIds.length === 0) return null;
  const expiresAt = new Date(
    new Date(input.createdAt).getTime() + (input.ttlDays || 30) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const binding: MemoryFeedbackBinding = {
    userId: input.userId,
    adoptId: input.adoptId,
    receiptId: input.receiptId,
    memoryIds: Array.from(new Set(input.memoryIds.map(String))).sort(),
    expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(binding)).toString("base64url");
  return { token: `${payload}.${signature(payload, secret)}`, expiresAt };
}

export function verifyContextReceiptMemoryFeedbackToken(input: {
  token: string;
  userId: number;
  adoptId: string;
  receiptId: string;
  memoryId: number;
  now?: Date;
}): boolean {
  const secret = signingSecret();
  if (!secret) return false;
  const [payload, suppliedSignature, extra] = String(input.token || "").split(".");
  if (!payload || !suppliedSignature || extra) return false;
  const expectedSignature = signature(payload, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  try {
    const binding = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<MemoryFeedbackBinding>;
    return binding.userId === input.userId
      && binding.adoptId === input.adoptId
      && binding.receiptId === input.receiptId
      && Array.isArray(binding.memoryIds)
      && binding.memoryIds.includes(String(input.memoryId))
      && typeof binding.expiresAt === "string"
      && new Date(binding.expiresAt).getTime() > (input.now || new Date()).getTime();
  } catch {
    return false;
  }
}
