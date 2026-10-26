import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

export const ABUSE_WINDOW_SECONDS = 60;
export const ABUSE_REQUEST_LIMIT = 120;
export const ABUSE_BLOCK_SECONDS = 5 * 60;
const RECORD_TTL_SECONDS = 24 * 60 * 60;

type Send = (command: GetCommand | PutCommand | UpdateCommand) => Promise<any>;

export class AbuseLimitError extends Error {
  readonly code: "ABUSE_BLOCKED" | "ABUSE_GUARD_BUSY";
  readonly statusCode: number;
  readonly retryAfterSeconds?: number;

  constructor(code: "ABUSE_BLOCKED" | "ABUSE_GUARD_BUSY", message: string, statusCode: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "AbuseLimitError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function blockedError(blockedUntil: number, now: number): AbuseLimitError {
  const retryAfterSeconds = Math.max(1, blockedUntil - now);
  return new AbuseLimitError(
    "ABUSE_BLOCKED",
    `Trop d’opérations en peu de temps. Réessayez dans ${retryAfterSeconds} secondes.`,
    429,
    retryAfterSeconds,
  );
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

/**
 * Atomically limits writes across all sessions/devices for one writer. A
 * threshold breach is recorded as a temporary block before the request fails.
 */
export async function enforceAbuseLimit(
  send: Send,
  tableName: string,
  writerId: string,
  nowMilliseconds = Date.now(),
  requestLimit = ABUSE_REQUEST_LIMIT,
): Promise<void> {
  const now = Math.floor(nowMilliseconds / 1000);
  const windowStart = Math.floor(now / ABUSE_WINDOW_SECONDS) * ABUSE_WINDOW_SECONDS;
  const key = { PK: `ABUSE#${writerId}`, SK: "RATE" };

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
    const item = current.Item as Record<string, unknown> | undefined;
    const blockedUntil = Number(item?.blockedUntil ?? 0);
    if (blockedUntil > now) throw blockedError(blockedUntil, now);

    if (!item || Number(item.windowStart) < windowStart) {
      try {
        await send(new PutCommand({
          TableName: tableName,
          Item: {
            ...key,
            writerId,
            windowStart,
            requestCount: 1,
            updatedAt: now,
            expiresAt: now + RECORD_TTL_SECONDS,
          },
          ConditionExpression: "attribute_not_exists(PK) OR windowStart < :windowStart",
          ExpressionAttributeValues: { ":windowStart": windowStart },
        }));
        return;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        continue;
      }
    }

    if (Number(item.windowStart) !== windowStart) continue;
    try {
      await send(new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: "SET updatedAt = :now, expiresAt = :expiresAt ADD requestCount :one",
        ConditionExpression: "windowStart = :windowStart AND requestCount < :limit AND (attribute_not_exists(blockedUntil) OR blockedUntil <= :now)",
        ExpressionAttributeValues: {
          ":now": now,
          ":expiresAt": now + RECORD_TTL_SECONDS,
          ":one": 1,
          ":windowStart": windowStart,
          ":limit": requestLimit,
        },
      }));
      return;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }

    const latest = await send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
    const latestItem = latest.Item as Record<string, unknown> | undefined;
    const latestBlockedUntil = Number(latestItem?.blockedUntil ?? 0);
    if (latestBlockedUntil > now) throw blockedError(latestBlockedUntil, now);
    if (Number(latestItem?.windowStart) !== windowStart || Number(latestItem?.requestCount ?? 0) < requestLimit) continue;

    const until = now + ABUSE_BLOCK_SECONDS;
    try {
      await send(new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: "SET blockedAt = :now, blockedUntil = :until, blockReason = :reason, updatedAt = :now, expiresAt = :expiresAt",
        ConditionExpression: "windowStart = :windowStart AND requestCount >= :limit AND (attribute_not_exists(blockedUntil) OR blockedUntil <= :now)",
        ExpressionAttributeValues: {
          ":now": now,
          ":until": until,
          ":reason": `Plus de ${requestLimit} opérations d’écriture en ${ABUSE_WINDOW_SECONDS} secondes`,
          ":expiresAt": until + RECORD_TTL_SECONDS,
          ":windowStart": windowStart,
          ":limit": requestLimit,
        },
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const raced = await send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
      const racedUntil = Number(raced.Item?.blockedUntil ?? 0);
      if (racedUntil > now) throw blockedError(racedUntil, now);
      continue;
    }
    throw blockedError(until, now);
  }

  throw new AbuseLimitError("ABUSE_GUARD_BUSY", "La protection anti-abus est momentanément occupée. Réessayez.", 503);
}
