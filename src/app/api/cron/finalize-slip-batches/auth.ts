export type CronAuthHeaderType =
  | "authorization-bearer"
  | "authorization-other"
  | "x-cron-secret-unsupported"
  | "none";

export interface CronAuthResult {
  authorized: boolean;
  secretConfigured: boolean;
  authHeaderPresent: boolean;
  headerTypeUsed: CronAuthHeaderType;
}

function readBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;

  const match = authHeader.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

export function checkCronAuth(
  secret: string | undefined,
  authHeader: string | null,
  xCronSecretHeader: string | null,
): CronAuthResult {
  const bearerToken = readBearerToken(authHeader);
  const headerTypeUsed: CronAuthHeaderType = authHeader
    ? bearerToken
      ? "authorization-bearer"
      : "authorization-other"
    : xCronSecretHeader
      ? "x-cron-secret-unsupported"
      : "none";

  return {
    authorized: Boolean(secret) && bearerToken === secret,
    secretConfigured: Boolean(secret),
    authHeaderPresent: Boolean(authHeader),
    headerTypeUsed,
  };
}
