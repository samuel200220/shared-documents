import assert from "node:assert/strict";
import test from "node:test";
import { buildQuotaUpdate, canApplyChange, DAILY_CHARACTER_LIMIT, measureTextChange, remainingQuota } from "../src/quota.js";

test("charge inserted characters, including replacements, but not pure deletions", () => {
  assert.deepEqual(measureTextChange("bonjour", "bonsoir"), {
    added: 0,
    deleted: 3,
    replaced: 3,
    chargeable: 3,
  });
  assert.equal(measureTextChange("abc", "ab").chargeable, 0);
  assert.equal(measureTextChange("abc", "abcd").chargeable, 1);
});

test("counts Unicode code points, not UTF-16 code units", () => {
  assert.equal(measureTextChange("a", "a🙂").chargeable, 1);
});

test("quota boundary is inclusive and remaining quota never goes below zero", () => {
  const change = measureTextChange("", "abc");
  assert.equal(canApplyChange(7, change, 10), true);
  assert.equal(canApplyChange(8, change, 10), false);
  assert.equal(remainingQuota(12, 10), 0);
});

test("quota transaction uses an atomic upper-bound condition", () => {
  const action = buildQuotaUpdate("writer-1", "2026-10-25", 3, "2026-10-25T00:00:00.000Z", "table");
  assert.equal(action.Update.TableName, "table");
  assert.equal(action.Update.Key.PK, "QUOTA#writer-1#2026-10-25");
  assert.match(action.Update.ConditionExpression, /used <= :maximum/);
  assert.equal(action.Update.ExpressionAttributeValues[":maximum"], 9_997);
  assert.throws(() => buildQuotaUpdate("writer-1", "2026-10-25", 0, "now", "table"), RangeError);
});

test("concurrent quota reservations cannot exceed the daily limit", async () => {
  let used = 9_700;
  const applyConditionally = async (amount: number) => {
    const action = buildQuotaUpdate("writer-1", "2026-10-25", amount, "now", "table");
    const values = action.Update.ExpressionAttributeValues;
    // The operation is synchronous, modeling DynamoDB's atomic condition + update.
    if (used > Number(values[":maximum"])) throw new Error("quota condition failed");
    used += Number(values[":amount"]);
  };
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => applyConditionally(100)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 3);
  assert.equal(used, DAILY_CHARACTER_LIMIT);
});
