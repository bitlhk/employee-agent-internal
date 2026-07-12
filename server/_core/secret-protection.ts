import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "crypto";

const ENCRYPTED_PREFIX = "enc:v1";

function masterSecret(): string {
  const value = String(process.env.CREDENTIAL_ENCRYPTION_KEY || process.env.JWT_SECRET || "").trim();
  if (!value) throw new Error("CREDENTIAL_ENCRYPTION_KEY or JWT_SECRET is required");
  return value;
}

function derivedKey(purpose: string): Buffer {
  return createHash("sha256").update(`${purpose}\0${masterSecret()}`).digest();
}

export function keyedDigest(purpose: "email-code" | "password-reset", value: string): string {
  const digest = createHmac("sha256", derivedKey(`digest:${purpose}`)).update(value).digest("base64url");
  return purpose === "email-code" ? digest.slice(0, 10) : `h1:${digest}`;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${ENCRYPTED_PREFIX}:`);
}

export function encryptSecret(plaintext: string, options: { maxStoredLength?: number | null } = {}): string {
  if (!plaintext || isEncryptedSecret(plaintext)) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey("encryption:credentials:v1"), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const stored = [ENCRYPTED_PREFIX, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
  const maxStoredLength = options.maxStoredLength === undefined ? 255 : options.maxStoredLength;
  if (maxStoredLength !== null && stored.length > maxStoredLength) {
    throw new Error("encrypted credential exceeds storage limit");
  }
  return stored;
}

export function decryptSecret(stored: string): string {
  if (!stored || !isEncryptedSecret(stored)) return stored;
  const [prefix, version, ivRaw, tagRaw, ciphertextRaw] = stored.split(":");
  if (`${prefix}:${version}` !== ENCRYPTED_PREFIX || !ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error("invalid encrypted credential format");
  }
  const decipher = createDecipheriv("aes-256-gcm", derivedKey("encryption:credentials:v1"), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
}
