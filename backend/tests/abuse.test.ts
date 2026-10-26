import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ABUSE_BLOCK_SECONDS, ABUSE_WINDOW_SECONDS, enforceAbuseLimit } from "../src/abuse.js";

function conditionalFailure(): Error {
  const error = new Error("conditional request failed");
  error.name = "ConditionalCheckFailedException";
  return error;
}

test("a writer is temporarily blocked after the atomic write-rate limit", async () => {
  let record: Record<string, unknown> | undefined;
  const now = Date.UTC(2026, 9, 25, 12, 0, 10);
  const nowSeconds = Math.floor(now / 1000);
  const windowStart = Math.floor(nowSeconds / ABUSE_WINDOW_SECONDS) * ABUSE_WINDOW_SECONDS;
  const send = async (command: GetCommand | PutCommand | UpdateCommand): Promise<any> => {
    if (command instanceof GetCommand) return { Item: record ? { ...record } : undefined };
    if (command instanceof PutCommand) {
      if (record && Number(record.windowStart) >= Number(command.input.ExpressionAttributeValues?.[":windowStart"])) throw conditionalFailure();
      record = { ...command.input.Item };
      return {};
    }
    const values = command.input.ExpressionAttributeValues ?? {};
    if (command.input.UpdateExpression?.includes("ADD requestCount")) {
      if (!record || record.windowStart !== values[":windowStart"] || Number(record.requestCount) >= Number(values[":limit"]) || Number(record.blockedUntil ?? 0) > Number(values[":now"])) throw conditionalFailure();
      record = { ...record, requestCount: Number(record.requestCount) + 1, updatedAt: values[":now"], expiresAt: values[":expiresAt"] };
      return {};
    }
    if (!record || record.windowStart !== values[":windowStart"] || Number(record.requestCount) < Number(values[":limit"]) || Number(record.blockedUntil ?? 0) > Number(values[":now"])) throw conditionalFailure();
    record = { ...record, blockedAt: values[":now"], blockedUntil: values[":until"], blockReason: values[":reason"] };
    return {};
  };

  await enforceAbuseLimit(send, "table", "writer-1", now, 3);
  await enforceAbuseLimit(send, "table", "writer-1", now + 1_000, 3);
  await enforceAbuseLimit(send, "table", "writer-1", now + 2_000, 3);
  await assert.rejects(enforceAbuseLimit(send, "table", "writer-1", now + 3_000, 3), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, "ABUSE_BLOCKED");
    assert.equal((error as Error & { retryAfterSeconds?: number }).retryAfterSeconds, ABUSE_BLOCK_SECONDS);
    return true;
  });
  assert.equal(record?.windowStart, windowStart);
  assert.equal(record?.requestCount, 3);
  assert.equal(record?.blockedUntil, nowSeconds + 3 + ABUSE_BLOCK_SECONDS);
});

test("a temporary block expires and the next UTC-independent window starts fresh", async () => {
  let record: Record<string, unknown> | undefined;
  const send = async (command: GetCommand | PutCommand | UpdateCommand): Promise<any> => {
    if (command instanceof GetCommand) return { Item: record ? { ...record } : undefined };
    if (command instanceof PutCommand) {
      const nextWindow = Number(command.input.ExpressionAttributeValues?.[":windowStart"]);
      if (record && Number(record.windowStart) >= nextWindow) throw conditionalFailure();
      record = { ...command.input.Item };
      return {};
    }
    throw new Error("Unexpected update");
  };
  const first = Date.UTC(2026, 9, 25, 12, 0, 10);
  await enforceAbuseLimit(send, "table", "writer-2", first, 1);
  const afterBlockAndWindow = first + (ABUSE_BLOCK_SECONDS + ABUSE_WINDOW_SECONDS + 5) * 1_000;
  await enforceAbuseLimit(send, "table", "writer-2", afterBlockAndWindow, 1);
  assert.equal(record?.requestCount, 1);
  assert.ok(Number(record?.windowStart) > Math.floor(first / 1_000));
  assert.equal(record?.blockedUntil, undefined);
});
