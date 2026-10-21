import { collaborationSettingsForTask } from "../../../shared/scheduling-collaboration-policy";
import type { Request, Response } from "express";
import {
  getClawByAdoptId,
  getCollabRequest,
  getCollabSettings,
} from "../../db";
import { sdk } from "../sdk";
import { projectCollaborationConclusion } from "./result-projection";
export function streamStandaloneCollaboration(
  req: Request,
  res: Response,
  requestId: number,
  userId: number,
  recipient: boolean
) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  let busy = false;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(timeout);
  };
  const tick = async () => {
    if (busy || stopped || res.writableEnded) return;
    busy = true;
    try {
      const authenticated = await sdk.authenticateRequest(req);
      const request = await getCollabRequest(requestId);
      const adoptId =
        request &&
        (recipient ? request.targetAdoptId : request.requesterAdoptId);
      const expectedUser =
        request && (recipient ? request.targetUserId : request.requesterUserId);
      const owner = adoptId ? await getClawByAdoptId(adoptId) : null;
      if (
        !request ||
        request.sessionId ||
        authenticated.id !== userId ||
        expectedUser !== userId ||
        owner?.userId !== userId ||
        owner.permissionProfile === "starter" ||
        !["active", "expiring"].includes(owner.status)
      )
        throw new Error("access revoked");
      const done = [
        "completed",
        "failed",
        "cancelled",
        "rejected",
        "partial_success",
        "waiting_input",
      ].includes(request.status);
      let resultSummary = "";
      if (done) {
        if (recipient) resultSummary = request.resultSummary || "";
        else {
          const target = await getClawByAdoptId(request.targetAdoptId);
          const settings =
            target?.userId === request.targetUserId
              ? await getCollabSettings(target.id)
              : null;
          if (target?.userId === request.targetUserId)
            resultSummary = projectCollaborationConclusion(
              request,
              collaborationSettingsForTask(settings, request.taskType)?.sharingPolicy === "result-only"
            ).summary;
        }
      }
      res.write(
        `data: ${JSON.stringify({ done, status: request.status, ...(done ? { resultSummary } : {}) })}\n\n`
      );
      if (done) {
        stop();
        res.end();
      }
    } catch {
      stop();
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ done: true, forbidden: true })}\n\n`
        );
        res.end();
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 2000);
  timer.unref();
  const timeout = setTimeout(() => {
    stop();
    if (!res.writableEnded) res.end();
  }, 10 * 60_000);
  timeout.unref();
  req.on("close", stop);
  void tick();
}
