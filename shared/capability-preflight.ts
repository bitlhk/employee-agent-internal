export type CapabilityKind = "model" | "skill" | "connector" | "expert" | "knowledge";
export type CapabilityReadiness = "ready" | "blocked" | "unchecked";

export type CapabilityPreflight = {
  kind: CapabilityKind;
  id: string;
  name: string;
  readiness: CapabilityReadiness;
  reason?: string;
};

export function summarizeCapabilityPreflight(entries: CapabilityPreflight[]): {
  ready: boolean;
  blocked: CapabilityPreflight[];
  unchecked: CapabilityPreflight[];
} {
  const blocked = entries.filter((entry) => entry.readiness === "blocked");
  const unchecked = entries.filter((entry) => entry.readiness === "unchecked");
  return { ready: blocked.length === 0, blocked, unchecked };
}
