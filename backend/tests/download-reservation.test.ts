import assert from "node:assert/strict";
import test from "node:test";
import type { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { reserveDownloadSlot } from "../src/downloads.js";

test("concurrent download reservations accept only the one remaining slot", async () => {
  let count = 4;
  const documentVersion = 3;
  const maxDownloads = 5;
  const send = async (command: TransactWriteCommand): Promise<unknown> => {
    const actions = command.input.TransactItems ?? [];
    assert.equal(actions.length, 2);
    const update = actions[0].Update!;
    const check = actions[1].ConditionCheck!;
    assert.equal(update.ConditionExpression,
      "attribute_exists(PK) AND (attribute_not_exists(downloadCount) OR downloadCount < maxDownloads)");
    assert.equal(check.ConditionExpression, "version = :version");
    assert.deepEqual(check.Key, { PK: "DOC#document-1", SK: "META" });
    // This synchronous compare-and-increment models a DynamoDB transaction.
    if (count >= maxDownloads) {
      const error = new Error("condition failed");
      error.name = "TransactionCanceledException";
      throw error;
    }
    count += 1;
    return {};
  };

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => reserveDownloadSlot(send, "table", "token-digest", "document-1", documentVersion)),
  );
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 19);
  assert.equal(count, maxDownloads);
});

test("a revision mismatch cancels the download reservation transaction", async () => {
  const send = async (command: TransactWriteCommand): Promise<unknown> => {
    const check = command.input.TransactItems?.[1].ConditionCheck!;
    assert.equal(check.ExpressionAttributeValues?.[":version"], 7);
    const error = new Error("document revision changed");
    error.name = "TransactionCanceledException";
    throw error;
  };

  await assert.rejects(reserveDownloadSlot(send, "table", "token-digest", "document-1", 7), {
    name: "TransactionCanceledException",
  });
});
