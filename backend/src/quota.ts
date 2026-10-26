export const DAILY_CHARACTER_LIMIT = 10_000;

export function buildQuotaUpdate(writerId: string, day: string, amount: number, now: string, tableName: string, limit = DAILY_CHARACTER_LIMIT) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > limit) throw new RangeError("amount must be between 1 and the quota limit");
  const expiresAt = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000) + 90 * 24 * 60 * 60;
  return {
    Update: {
      TableName: tableName,
      Key: { PK: `QUOTA#${writerId}#${day}`, SK: "COUNTER" },
      UpdateExpression: "SET used = if_not_exists(used, :zero) + :amount, updatedAt = :now, expiresAt = :expiresAt",
      ConditionExpression: "attribute_not_exists(used) OR used <= :maximum",
      ExpressionAttributeValues: { ":zero": 0, ":amount": amount, ":maximum": limit - amount, ":now": now, ":expiresAt": expiresAt },
    },
  };
}

export interface TextChange {
  added: number;
  deleted: number;
  /** Added characters that replace deleted characters in the changed span. */
  replaced: number;
  /** Only newly written characters consume the quota; pure deletion is free. */
  chargeable: number;
}

/** Counts Unicode code points rather than UTF-16 code units. */
export function measureTextChange(previous: string, next: string): TextChange {
  const before = Array.from(previous);
  const after = Array.from(next);
  let prefix = 0;

  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const deleted = before.length - prefix - suffix;
  const inserted = after.length - prefix - suffix;
  const replaced = Math.min(deleted, inserted);
  return { added: inserted - replaced, deleted, replaced, chargeable: inserted };
}

export function remainingQuota(used: number, limit = DAILY_CHARACTER_LIMIT): number {
  return Math.max(0, limit - used);
}

export function canApplyChange(used: number, change: TextChange, limit = DAILY_CHARACTER_LIMIT): boolean {
  return Number.isSafeInteger(used) && used >= 0 && used + change.chargeable <= limit;
}
