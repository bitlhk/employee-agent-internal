import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { recordInstallEvent } from "../db/install-telemetry";

export const INSTALLER_VERSION = "2026.07.14.1";

const identifierSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{16,64}$/);
const tokenSchema = z.string().trim().regex(/^[A-Za-z0-9._:-]{1,64}$/);

export const publicInstallEventSchema = z.object({
  installId: identifierSchema,
  eventType: z.enum(["command_copied", "started", "succeeded", "failed"]),
  stage: tokenSchema.optional(),
  source: z.string().trim().regex(/^[A-Za-z0-9._-]{1,32}$/).optional(),
  installerVersion: z.string().trim().regex(/^[A-Za-z0-9._+-]{1,32}$/).optional(),
  osType: z.string().trim().regex(/^[A-Za-z0-9._-]{1,32}$/).optional(),
  arch: z.string().trim().regex(/^[A-Za-z0-9._-]{1,32}$/).optional(),
  mirror: z.enum(["auto", "cn", "official", "unknown"]).optional(),
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
}).strict();

const installTelemetryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many telemetry events" },
});

export function registerInstallTelemetryRoutes(app: Express): void {
  app.post(
    "/api/public/install-events",
    installTelemetryLimiter,
    express.json({ limit: "4kb", strict: true }),
    async (req, res) => {
      const parsed = publicInstallEventSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid install event" });
        return;
      }

      try {
        await recordInstallEvent(parsed.data);
      } catch (error) {
        // Telemetry must never become part of the installer success path.
        console.error("[install-telemetry] failed to record public event", error);
      }
      res.status(202).json({ accepted: true });
    },
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function resolveInstallTelemetryEndpoint(): string | null {
  const configured = String(
    process.env.EMPLOYEE_AGENT_INSTALL_TELEMETRY_ENDPOINT
      || process.env.INSTALL_TELEMETRY_ENDPOINT
      || "",
  ).trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    const isDevelopmentLoopback = process.env.NODE_ENV !== "production"
      && url.protocol === "http:"
      && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !isDevelopmentLoopback) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function injectInstallerTelemetry(
  script: string,
  input: { installId: string; endpoint: string; source?: string },
): string {
  const installId = identifierSchema.parse(input.installId);
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("Unsupported install telemetry endpoint");
  }
  const source = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/).parse(input.source || "official");
  const prelude = [
    `EMPLOYEE_AGENT_INSTALL_ID=${shellSingleQuote(installId)}`,
    `EMPLOYEE_AGENT_INSTALL_TELEMETRY_ENDPOINT=${shellSingleQuote(endpoint.toString())}`,
    `EMPLOYEE_AGENT_INSTALL_SOURCE=${shellSingleQuote(source)}`,
  ].join("\n");

  if (script.startsWith("#!")) {
    const newline = script.indexOf("\n");
    if (newline >= 0) return `${script.slice(0, newline + 1)}${prelude}\n${script.slice(newline + 1)}`;
  }
  return `${prelude}\n${script}`;
}
