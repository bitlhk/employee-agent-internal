import { isIP } from "net";

export function resolveAppBindIp(raw = process.env.APP_BIND_IP): string {
  const value = String(raw || "127.0.0.1").trim();
  if (value === "localhost") return "127.0.0.1";
  if (!isIP(value)) throw new Error("APP_BIND_IP must be a valid IPv4 or IPv6 address");
  return value;
}
