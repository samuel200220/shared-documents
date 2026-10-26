import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

export async function reserveDownloadSlot(
  send: (command: TransactWriteCommand) => Promise<unknown>,
  table: string,
  tokenHash: string,
  documentId: string,
  documentVersion: number,
): Promise<void> {
  await send(new TransactWriteCommand({
    TransactItems: [
      { Update: {
        TableName: table,
        Key: { PK: `DOWNLOAD#${tokenHash}`, SK: "META" },
        UpdateExpression: "SET downloadCount = if_not_exists(downloadCount, :zero) + :one",
        ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(downloadCount) OR downloadCount < maxDownloads)",
        ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
      } },
      { ConditionCheck: {
        TableName: table,
        Key: { PK: `DOC#${documentId}`, SK: "META" },
        ConditionExpression: "version = :version",
        ExpressionAttributeValues: { ":version": documentVersion },
      } },
    ],
  }));
}
