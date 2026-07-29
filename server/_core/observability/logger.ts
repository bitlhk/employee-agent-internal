import pino from "pino";
import { redactLogPreview } from "../log-privacy";
import { getRequestContext } from "./request-context";

export type LogFields = Record<string, unknown>;

const credentialNames = [
  "authorization",
  "cookie",
  "password",
  "passphrase",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "api_key",
  "secret",
  "clientSecret",
  "privateKey",
];

const redactPaths = credentialNames.flatMap((name) => [
  name,
  `*.${name}`,
  `*.*.${name}`,
  `*.*.*.${name}`,
]);

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: {
    service: "employee-agent",
    environment: process.env.NODE_ENV || "development",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: redactPaths,
    censor: "[REDACTED]",
  },
});

function payload(event: string, fields: LogFields): LogFields {
  const context = getRequestContext();
  return {
    event,
    ...(context || {}),
    ...fields,
  };
}

export function safeErrorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) {
    return { errorName: "Error", errorMessage: redactLogPreview(error || "unknown error") };
  }
  const code = "code" in error && typeof error.code === "string" ? error.code.slice(0, 80) : undefined;
  return {
    errorName: error.name.slice(0, 120),
    errorMessage: redactLogPreview(error.message),
    ...(code ? { errorCode: code } : {}),
  };
}

export function logDebug(event: string, fields: LogFields = {}, message = event): void {
  logger.debug(payload(event, fields), message);
}

export function logInfo(event: string, fields: LogFields = {}, message = event): void {
  logger.info(payload(event, fields), message);
}

export function logWarn(event: string, fields: LogFields = {}, message = event): void {
  logger.warn(payload(event, fields), message);
}

export function logError(event: string, error: unknown, fields: LogFields = {}, message = event): void {
  logger.error(payload(event, { ...fields, ...safeErrorFields(error) }), message);
}

export function logFatal(event: string, error: unknown, fields: LogFields = {}, message = event): void {
  logger.fatal(payload(event, { ...fields, ...safeErrorFields(error) }), message);
}

export function flushApplicationLogs(): void {
  logger.flush();
}
