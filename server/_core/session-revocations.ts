import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

export class SessionRevocationStore {
  constructor(private readonly filePath: string) {}

  private read(nowSeconds: number): Record<string, number> {
    try {
      const parsed = existsSync(this.filePath) ? JSON.parse(readFileSync(this.filePath, "utf8")) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const active: Record<string, number> = {};
      for (const [jti, exp] of Object.entries(parsed)) {
        if (jti && typeof exp === "number" && exp > nowSeconds) active[jti] = exp;
      }
      return active;
    } catch {
      return {};
    }
  }

  isRevoked(jti: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    const entries = this.read(nowSeconds);
    return Object.prototype.hasOwnProperty.call(entries, jti);
  }

  revoke(jti: string, expiresAtSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!jti || expiresAtSeconds <= nowSeconds) return;
    const entries = this.read(nowSeconds);
    entries[jti] = expiresAtSeconds;
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o750 });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(entries), { encoding: "utf8", mode: 0o640 });
    renameSync(temporary, this.filePath);
  }
}

export const sessionRevocations = new SessionRevocationStore(
  process.env.SESSION_REVOCATION_PATH || path.join(process.env.APP_ROOT || process.cwd(), "data", "session-revocations.json"),
);
