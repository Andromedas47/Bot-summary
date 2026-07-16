export interface AuthMetadata { role?: unknown; correction_approver?: unknown }

export function isCorrectionApprover(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const value = metadata as AuthMetadata;
  return value.role === "admin" || value.correction_approver === true || value.correction_approver === "true";
}
