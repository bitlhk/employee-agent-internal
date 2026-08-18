export type RoleHomeStatus = "READY" | "DEGRADED" | "BLOCKED";

export type RoleHomeTaskStatus = {
  taskId: string;
  status: RoleHomeStatus;
  reason?: string;
  remediation?: string;
};

export type RoleHomeCapabilityStatus = {
  id: string;
  label: string;
  status: RoleHomeStatus;
  statusLabel: string;
};

export type RoleHomeRuntimeStatus = {
  roleTemplate: string;
  checkedAt: string;
  tasks: RoleHomeTaskStatus[];
  capabilities: RoleHomeCapabilityStatus[];
};
