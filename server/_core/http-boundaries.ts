import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { getRequestContext } from "./observability/request-context";

export const DEFAULT_JSON_LIMIT_BYTES = 2 * 1024 * 1024;
export const LARGE_UPLOAD_LIMIT_BYTES = 80 * 1024 * 1024;

const LARGE_JSON_UPLOAD_PATHS = new Set([
  "/api/claw/files/upload",
  "/api/claw/skill-package/upload",
  "/api/coop/upload",
  "/api/desktop/files/upload",
  "/api/knowledge/documents/upload",
]);

const LARGE_RAW_UPLOAD_PATHS = new Set([
  "/api/claw/skill-market/upload",
]);

function requestPath(req: Pick<Request, "path" | "originalUrl">): string {
  return String(req.path || req.originalUrl || "").split("?", 1)[0].replace(/\/$/, "") || "/";
}

export function isLargeJsonUploadRequest(req: Pick<Request, "path" | "originalUrl">): boolean {
  return LARGE_JSON_UPLOAD_PATHS.has(requestPath(req));
}

export function requestEnvelopeLimit(req: Pick<Request, "path" | "originalUrl">): number {
  const path = requestPath(req);
  return LARGE_JSON_UPLOAD_PATHS.has(path) || LARGE_RAW_UPLOAD_PATHS.has(path)
    ? LARGE_UPLOAD_LIMIT_BYTES
    : DEFAULT_JSON_LIMIT_BYTES;
}

function isJsonContentType(req: Request): boolean {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return contentType.includes("application/json") || contentType.includes("+json");
}

export const largeUploadJsonParser: RequestHandler = express.json({
  limit: LARGE_UPLOAD_LIMIT_BYTES,
  type: (req) => isLargeJsonUploadRequest(req as Request) && isJsonContentType(req as Request),
});

export const defaultJsonParser: RequestHandler = express.json({ limit: DEFAULT_JSON_LIMIT_BYTES });
export const defaultUrlencodedParser: RequestHandler = express.urlencoded({
  limit: DEFAULT_JSON_LIMIT_BYTES,
  extended: true,
});

function responseRequestId(res: Response): string {
  return getRequestContext()?.requestId || String(res.getHeader("x-request-id") || "").trim() || "unknown";
}

export const sanitizeServerErrorResponses: RequestHandler = (_req, res, next: NextFunction) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 500) {
      return originalJson({
        error: "内部服务器错误",
        code: "INTERNAL_ERROR",
        requestId: responseRequestId(res),
      });
    }
    return originalJson(body);
  }) as Response["json"];
  next();
};

