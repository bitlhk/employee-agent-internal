import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { sdk, type AuthenticatedUser } from "./sdk";
import { logError } from "./observability/logger";
import { updateRequestContext } from "./observability/request-context";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: AuthenticatedUser | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: AuthenticatedUser | null = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    // 记录错误但不抛出，允许未认证的请求继续
    if (error instanceof Error && !error.message.includes("Invalid session")) {
      logError("auth.context.failed", error);
    }
    user = null;
  }

  if (user) updateRequestContext({ userId: Number(user.id) });

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
