import express from "express";
import { requireClawOwner } from "./helpers";
import { retiredRuntimeMessage } from "./runtime-policy";

const retiredPolicyResponse = {
  error: "RUNTIME_RETIRED",
  retired: true,
  message: retiredRuntimeMessage(),
};

export function registerToolsPolicyRoutes(app: express.Express) {
  const handleRetiredPolicy = async (req: express.Request, res: express.Response) => {
    const adoptId = String(req.query.adoptId || "").trim();
    if (!adoptId) return res.status(400).json({ error: "adoptId required" });
    const claw = await requireClawOwner(req, res, adoptId);
    if (!claw) return;

    return res.status(410).json({
      adoptId,
      ...retiredPolicyResponse,
    });
  };

  // Preserve historical URLs during the compatibility window without reading
  // OpenClaw configuration or inferring a host execution policy.
  app.get("/api/claw/tools/policy", handleRetiredPolicy);
  app.get("/api/claw/tools/effective", handleRetiredPolicy);
}
