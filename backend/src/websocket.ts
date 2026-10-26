import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import * as Y from "yjs";
import { enforceAbuseLimit } from "./abuse.js";
import { DAILY_CHARACTER_LIMIT, buildQuotaUpdate, measureTextChange } from "./quota.js";

const tableName = process.env.APP_TABLE ?? "SharedDocsLocal";
const bucketName = process.env.DOCUMENTS_BUCKET ?? "";
const endpoint = process.env.WEBSOCKET_ENDPOINT;
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const management = new ApiGatewayManagementApiClient(endpoint ? { endpoint } : {});
const MAX_UPDATE_BYTES = 64_000;
const MAX_DOCUMENT_BYTES = 180_000;
const MAX_STATE_BYTES = 2_000_000;
const OUTBOUND_CHUNK_BYTES = 18_000;
const CONNECTION_TTL_SECONDS = 2 * 60 * 60;
const DEDUPE_TTL_SECONDS = 90 * 24 * 60 * 60;

interface WebSocketEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext: {
    eventType: "CONNECT" | "MESSAGE" | "DISCONNECT";
    connectionId?: string;
    routeKey: string;
  };
}

interface DocumentItem {
  documentId: string;
  ownerId: string;
  content: string;
  version: number;
}

interface StatePointer {
  stateVersion: number;
  epoch: number;
  stateKey: string;
}

interface RoomState {
  document: DocumentItem;
  pointer: StatePointer;
  ydoc: Y.Doc;
}

interface ConnectionItem {
  documentId: string;
  connectionId: string;
  writerId: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  expiresAt: number;
}

interface Message {
  action?: string;
  updateId?: string;
  update?: string;
  stateVector?: string;
  epoch?: number;
  position?: number;
  line?: number;
  col?: number;
}

export interface VersionSnapshot {
  PK: string;
  SK: string;
  snapshotId: string;
  documentVersion: number;
  s3Key: string;
  createdAt: string;
  createdBy: string;
  restoredFrom?: string;
  title: string;
  label?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code: string, message: string, statusCode = 409): never {
  const error = new Error(message) as Error & { code: string; statusCode: number };
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function createYDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  if (text.length) doc.getText("content").insert(0, text);
  return doc;
}

async function loadDoc(documentId: string): Promise<DocumentItem> {
  const result = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `DOC#${documentId}`, SK: "META" },
    ConsistentRead: true,
  }));
  if (!result.Item) fail("DOCUMENT_NOT_FOUND", "Ce document n’existe pas.");
  return result.Item as unknown as DocumentItem;
}

async function loadPointer(documentId: string): Promise<StatePointer | null> {
  const result = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `DOC#${documentId}`, SK: "CRDT#STATE" },
    ConsistentRead: true,
  }));
  if (!result.Item) return null;
  return { stateVersion: Number(result.Item.stateVersion), epoch: Number(result.Item.epoch), stateKey: String(result.Item.stateKey) };
}

async function saveObject(key: string, bytes: Uint8Array): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: bytes,
    ContentType: "application/octet-stream",
    ServerSideEncryption: "AES256",
  }));
}

async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

async function readState(key: string): Promise<Uint8Array> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) fail("STATE_MISSING", "L’état collaboratif du document est introuvable.");
  return bytes;
}

async function ensureState(documentId: string): Promise<RoomState> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const document = await loadDoc(documentId);
    const pointer = await loadPointer(documentId);
    if (pointer) {
      const bytes = await readState(pointer.stateKey);
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, bytes);
      return { document, pointer, ydoc };
    }

    const ydoc = createYDoc(document.content);
    const bytes = Y.encodeStateAsUpdate(ydoc);
    const stateKey = `crdt/${documentId}/state-${randomUUID()}.bin`;
    await saveObject(stateKey, bytes);
    const now = new Date().toISOString();
    try {
      await dynamo.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tableName, Item: { PK: `DOC#${documentId}`, SK: "CRDT#STATE", stateVersion: 1, epoch: 1, stateKey, updatedAt: now }, ConditionExpression: "attribute_not_exists(PK)" } },
          { ConditionCheck: { TableName: tableName, Key: { PK: `DOC#${documentId}`, SK: "META" }, ConditionExpression: "version = :version", ExpressionAttributeValues: { ":version": document.version } } },
        ],
      }));
      return { document, pointer: { stateVersion: 1, epoch: 1, stateKey }, ydoc };
    } catch (error) {
      await deleteObject(stateKey).catch(() => undefined);
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
    }
  }
  fail("STATE_BUSY", "Le document change trop rapidement pour initialiser la collaboration. Réessayez.");
}

async function findRole(documentId: string, writerId: string, document: DocumentItem): Promise<ConnectionItem["role"] | null> {
  if (document.ownerId === writerId) return "owner";
  const result = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `DOC#${documentId}`, SK: `ACL#${writerId}` },
    ConsistentRead: true,
  }));
  return result.Item?.role === "editor" || result.Item?.role === "viewer" ? result.Item.role : null;
}

async function connect(event: WebSocketEvent, connectionId: string): Promise<number> {
  const ticket = event.queryStringParameters?.ticket;
  const documentId = event.queryStringParameters?.documentId;
  if (!ticket || !documentId || ticket.length < 40) return 401;
  const now = Math.floor(Date.now() / 1000);
  let ticketItem: Record<string, unknown>;
  try {
    const result = await dynamo.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `WSTICKET#${sha256(ticket)}`, SK: "META" },
      UpdateExpression: "SET usedAt = :usedAt",
      ConditionExpression: "attribute_exists(PK) AND expiresAt > :now AND attribute_not_exists(usedAt)",
      ExpressionAttributeValues: { ":usedAt": new Date(now * 1000).toISOString(), ":now": now },
      ReturnValues: "ALL_NEW",
    }));
    ticketItem = result.Attributes ?? {};
  } catch {
    return 401;
  }
  if (ticketItem.documentId !== documentId) return 403;
  const writerId = String(ticketItem.writerId);
  const document = await loadDoc(documentId);
  const role = await findRole(documentId, writerId, document);
  if (!role) return 403;
  await ensureState(documentId);
  const expiresAt = now + CONNECTION_TTL_SECONDS;
  const row = { documentId, connectionId, writerId, name: String(ticketItem.name ?? ""), role, expiresAt, connectedAt: new Date(now * 1000).toISOString() };
  await dynamo.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: tableName, Item: { PK: `CONNECTION#${connectionId}`, SK: "META", ...row } } },
      { Put: { TableName: tableName, Item: { PK: `DOC#${documentId}`, SK: `CONN#${connectionId}`, ...row } } },
    ],
  }));
  return 200;
}

async function connectionFor(connectionId: string): Promise<ConnectionItem | null> {
  const result = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `CONNECTION#${connectionId}`, SK: "META" },
    ConsistentRead: true,
  }));
  if (!result.Item || Number(result.Item.expiresAt) <= Math.floor(Date.now() / 1000)) return null;
  return result.Item as unknown as ConnectionItem;
}

async function refreshConnection(connection: ConnectionItem): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS;
  await dynamo.send(new TransactWriteCommand({
    TransactItems: [
      { Update: { TableName: tableName, Key: { PK: `CONNECTION#${connection.connectionId}`, SK: "META" }, UpdateExpression: "SET expiresAt = :expiresAt", ExpressionAttributeValues: { ":expiresAt": expiresAt } } },
      { Update: { TableName: tableName, Key: { PK: `DOC#${connection.documentId}`, SK: `CONN#${connection.connectionId}` }, UpdateExpression: "SET expiresAt = :expiresAt", ExpressionAttributeValues: { ":expiresAt": expiresAt } } },
    ],
  }));
  connection.expiresAt = expiresAt;
}

async function post(connectionId: string, message: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(message));
  await management.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: body }));
}

async function sendBinary(connectionId: string, kind: "sync" | "update", epoch: number, bytes: Uint8Array, meta: Record<string, unknown> = {}): Promise<void> {
  const transferId = randomUUID();
  const partCount = Math.max(1, Math.ceil(bytes.byteLength / OUTBOUND_CHUNK_BYTES));
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const start = partIndex * OUTBOUND_CHUNK_BYTES;
    const data = Buffer.from(bytes.subarray(start, Math.min(start + OUTBOUND_CHUNK_BYTES, bytes.byteLength))).toString("base64");
    await post(connectionId, { type: "binary-part", kind, transferId, epoch, partIndex, partCount, data, ...meta });
  }
}

async function participantList(documentId: string): Promise<Array<{ writerId: string; name: string }>> {
  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `DOC#${documentId}`, ":prefix": "CONN#" },
    Limit: 1_000,
  }));
  const now = Math.floor(Date.now() / 1000);
  const unique = new Map<string, { writerId: string; name: string }>();
  for (const item of result.Items ?? []) {
    if (Number(item.expiresAt) > now) unique.set(String(item.writerId), { writerId: String(item.writerId), name: String(item.name) });
  }
  return [...unique.values()];
}

async function broadcast(documentId: string, message: unknown, exceptConnectionId?: string): Promise<void> {
  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `DOC#${documentId}`, ":prefix": "CONN#" },
    Limit: 1_000,
  }));
  const now = Math.floor(Date.now() / 1000);
  for (const item of result.Items ?? []) {
    const connectionId = String(item.connectionId);
    if (connectionId === exceptConnectionId || Number(item.expiresAt) <= now) continue;
    try {
      await post(connectionId, message);
    } catch (error) {
      if (error instanceof Error && error.name === "GoneException") await removeConnection(connectionId, documentId);
    }
  }
}

async function broadcastBinary(
  documentId: string,
  kind: "sync" | "update",
  epoch: number,
  bytes: Uint8Array,
  meta: Record<string, unknown>,
  exceptConnectionId?: string,
): Promise<void> {
  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `DOC#${documentId}`, ":prefix": "CONN#" },
    Limit: 1_000,
  }));
  const now = Math.floor(Date.now() / 1000);
  for (const item of result.Items ?? []) {
    const connectionId = String(item.connectionId);
    if (connectionId === exceptConnectionId || Number(item.expiresAt) <= now) continue;
    try {
      await sendBinary(connectionId, kind, epoch, bytes, meta);
    } catch (error) {
      if (error instanceof Error && error.name === "GoneException") await removeConnection(connectionId, documentId);
      else console.error(JSON.stringify({ level: "warn", code: "WEBSOCKET_DELIVERY_FAILED" }));
    }
  }
}

async function removeConnection(connectionId: string, knownDocumentId?: string): Promise<void> {
  const connection = knownDocumentId ? { documentId: knownDocumentId } : await connectionFor(connectionId);
  if (!connection) return;
  await dynamo.send(new TransactWriteCommand({
    TransactItems: [
      { Delete: { TableName: tableName, Key: { PK: `CONNECTION#${connectionId}`, SK: "META" } } },
      { Delete: { TableName: tableName, Key: { PK: `DOC#${connection.documentId}`, SK: `CONN#${connectionId}` } } },
    ],
  }));
}

async function syncClient(connection: ConnectionItem, stateVectorText?: string, reset = false): Promise<void> {
  const state = await ensureState(connection.documentId);
  let stateVector = new Uint8Array();
  if (stateVectorText) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(stateVectorText) || stateVectorText.length > 90_000) {
      fail("INVALID_STATE_VECTOR", "Le vecteur d’état est invalide.");
    }
    stateVector = Buffer.from(stateVectorText, "base64");
  }
  const update = Y.encodeStateAsUpdate(state.ydoc, stateVector);
  await sendBinary(connection.connectionId, "sync", state.pointer.epoch, update, {
    stateVector: Buffer.from(Y.encodeStateVector(state.ydoc)).toString("base64"),
    reset,
  });
  const participants = await participantList(connection.documentId);
  await post(connection.connectionId, { type: "presence", participants });
  await broadcast(connection.documentId, { type: "presence", participants }, connection.connectionId);
}

export async function restoreCollaborative(
  documentId: string,
  writerId: string,
  content: string,
  snapshot: VersionSnapshot,
): Promise<{ version: number; epoch: number }> {
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) fail("DOCUMENT_TOO_LARGE", "Le document dépasse 180 Ko.", 413);
  const quotaDay = utcDay();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await ensureState(documentId);
    const oldContent = state.ydoc.getText("content").toString();
    const change = measureTextChange(oldContent, content);
    const restoredDoc = createYDoc(content);
    const bytes = Y.encodeStateAsUpdate(restoredDoc);
    const nextStateVersion = state.pointer.stateVersion + 1;
    const nextEpoch = state.pointer.epoch + 1;
    const nextVersion = state.document.version + 1;
    const stateKey = `crdt/${documentId}/state-${randomUUID()}.bin`;
    const now = new Date().toISOString();
    await saveObject(stateKey, bytes);
    const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]>["TransactItems"] = [
      { Update: {
        TableName: tableName,
        Key: { PK: `DOC#${documentId}`, SK: "CRDT#STATE" },
        UpdateExpression: "SET stateVersion = :nextState, epoch = :nextEpoch, stateKey = :stateKey, updatedAt = :now",
        ConditionExpression: "stateVersion = :expectedState AND epoch = :expectedEpoch",
        ExpressionAttributeValues: { ":nextState": nextStateVersion, ":nextEpoch": nextEpoch, ":stateKey": stateKey, ":now": now, ":expectedState": state.pointer.stateVersion, ":expectedEpoch": state.pointer.epoch },
      } },
      { Update: {
        TableName: tableName,
        Key: { PK: `DOC#${documentId}`, SK: "META" },
        UpdateExpression: "SET content = :content, version = :nextVersion, updatedAt = :now",
        ConditionExpression: "version = :expectedVersion",
        ExpressionAttributeValues: { ":content": content, ":nextVersion": nextVersion, ":now": now, ":expectedVersion": state.document.version },
      } },
      { Put: { TableName: tableName, Item: snapshot, ConditionExpression: "attribute_not_exists(PK)" } },
    ];
    if (change.chargeable > 0) writes.push(buildQuotaUpdate(writerId, quotaDay, change.chargeable, now, tableName));
    try {
      await dynamo.send(new TransactWriteCommand({ TransactItems: writes }));
    } catch (error) {
      await deleteObject(stateKey).catch(() => undefined);
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
      const current = await loadPointer(documentId);
      if (current && (current.epoch !== state.pointer.epoch || current.stateVersion !== state.pointer.stateVersion)) continue;
      if (change.chargeable > 0) {
        const quota = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `QUOTA#${writerId}#${quotaDay}`, SK: "COUNTER" }, ConsistentRead: true }));
        if (Number(quota.Item?.used ?? 0) + change.chargeable > DAILY_CHARACTER_LIMIT) fail("QUOTA_EXHAUSTED", "Votre quota quotidien est épuisé. La restauration n’a pas été appliquée.", 429);
      }
      throw error;
    }
    await deleteObject(state.pointer.stateKey).catch(() => undefined);
    await broadcastBinary(documentId, "sync", nextEpoch, bytes, {
      reset: true,
      documentVersion: nextVersion,
      stateVector: Buffer.from(Y.encodeStateVector(restoredDoc)).toString("base64"),
    });
    return { version: nextVersion, epoch: nextEpoch };
  }
  fail("DOCUMENT_BUSY", "D’autres modifications arrivent. Rechargez l’historique puis réessayez.");
}

async function duplicateUpdate(connection: ConnectionItem, updateId: string, updateHash: string): Promise<boolean> {
  const result = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `DOC#${connection.documentId}`, SK: `CRDT#UPDATE#${updateId}` },
    ConsistentRead: true,
  }));
  if (!result.Item) return false;
  if (result.Item.updateHash !== updateHash) fail("UPDATE_ID_REUSED", "Cet identifiant a déjà été utilisé pour une autre mise à jour.");
  return true;
}

async function processUpdate(connection: ConnectionItem, message: Message): Promise<void> {
  if (connection.role === "viewer") fail("READ_ONLY", "Vous avez un accès en lecture seule.");
  await enforceAbuseLimit((command) => dynamo.send(command as never), tableName, connection.writerId);
  if (!message.updateId || !/^[A-Za-z0-9_-]{12,80}$/.test(message.updateId)) fail("INVALID_UPDATE_ID", "L’identifiant de mise à jour est invalide.");
  if (typeof message.update !== "string" || message.update.length > Math.ceil(MAX_UPDATE_BYTES * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.update)) {
    fail("INVALID_UPDATE", "La mise à jour collaborative est invalide ou dépasse 64 Ko.");
  }
  const update = Buffer.from(message.update, "base64");
  if (update.byteLength === 0 || update.byteLength > MAX_UPDATE_BYTES) fail("INVALID_UPDATE", "La mise à jour collaborative est invalide ou dépasse 64 Ko.");
  const updateHash = sha256(message.update);
  if (await duplicateUpdate(connection, message.updateId, updateHash)) {
    await post(connection.connectionId, { type: "ack", updateId: message.updateId, duplicate: true });
    return;
  }
  const document = await loadDoc(connection.documentId);
  const role = await findRole(connection.documentId, connection.writerId, document);
  if (!role || role === "viewer") fail("READ_ONLY", "Votre accès au document ne permet pas la modification.");

  const quotaDay = utcDay();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const state = await ensureState(connection.documentId);
    if (!Number.isInteger(message.epoch) || message.epoch !== state.pointer.epoch) {
      await syncClient(connection);
      fail("EPOCH_CHANGED", "Le document a été restauré. L’état a été resynchronisé.");
    }
    const beforeText = state.ydoc.getText("content").toString();
    try {
      Y.applyUpdate(state.ydoc, update);
    } catch {
      fail("INVALID_UPDATE", "La mise à jour Yjs ne peut pas être appliquée.");
    }
    const nextText = state.ydoc.getText("content").toString();
    if (Buffer.byteLength(nextText, "utf8") > MAX_DOCUMENT_BYTES) fail("DOCUMENT_TOO_LARGE", "Le document dépasse 180 Ko.");
    const change = measureTextChange(beforeText, nextText);
    const stateBytes = Y.encodeStateAsUpdate(state.ydoc);
    if (stateBytes.byteLength > MAX_STATE_BYTES) fail("STATE_TOO_LARGE", "L’état collaboratif a atteint la taille maximale de 2 Mo.");
    const nextStateVersion = state.pointer.stateVersion + 1;
    const nextDocumentVersion = state.document.version + (nextText === beforeText ? 0 : 1);
    const nextStateKey = `crdt/${connection.documentId}/state-${randomUUID()}.bin`;
    const now = new Date().toISOString();
    await saveObject(nextStateKey, stateBytes);
    const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]>["TransactItems"] = [
      { Update: {
        TableName: tableName,
        Key: { PK: `DOC#${connection.documentId}`, SK: "CRDT#STATE" },
        UpdateExpression: "SET stateVersion = :nextState, stateKey = :stateKey, updatedAt = :now",
        ConditionExpression: "stateVersion = :expectedState AND epoch = :epoch",
        ExpressionAttributeValues: { ":nextState": nextStateVersion, ":stateKey": nextStateKey, ":now": now, ":expectedState": state.pointer.stateVersion, ":epoch": state.pointer.epoch },
      } },
      { Put: {
        TableName: tableName,
        Item: { PK: `DOC#${connection.documentId}`, SK: `CRDT#UPDATE#${message.updateId}`, updateHash, writerId: connection.writerId, createdAt: now, expiresAt: Math.floor(Date.now() / 1000) + DEDUPE_TTL_SECONDS },
        ConditionExpression: "attribute_not_exists(PK)",
      } },
    ];
    if (nextText !== beforeText) {
      writes.push({ Update: {
        TableName: tableName,
        Key: { PK: `DOC#${connection.documentId}`, SK: "META" },
        UpdateExpression: "SET content = :content, version = :nextVersion, updatedAt = :now",
        ConditionExpression: "version = :expectedVersion",
        ExpressionAttributeValues: { ":content": nextText, ":nextVersion": nextDocumentVersion, ":now": now, ":expectedVersion": state.document.version },
      } });
    }
    if (change.chargeable > 0) writes.push(buildQuotaUpdate(connection.writerId, quotaDay, change.chargeable, now, tableName));
    try {
      await dynamo.send(new TransactWriteCommand({ TransactItems: writes }));
    } catch (error) {
      await deleteObject(nextStateKey).catch(() => undefined);
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
      if (await duplicateUpdate(connection, message.updateId, updateHash)) {
        await post(connection.connectionId, { type: "ack", updateId: message.updateId, duplicate: true });
        return;
      }
      const currentPointer = await loadPointer(connection.documentId);
      if (message.epoch !== currentPointer?.epoch) {
        await syncClient(connection, undefined, true);
        fail("EPOCH_CHANGED", "Le document a été restauré. L’état a été resynchronisé.");
      }
      if (currentPointer && currentPointer.stateVersion !== state.pointer.stateVersion) continue;
      if (change.chargeable > 0) {
        const quota = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `QUOTA#${connection.writerId}#${quotaDay}`, SK: "COUNTER" }, ConsistentRead: true }));
        if (Number(quota.Item?.used ?? 0) + change.chargeable > DAILY_CHARACTER_LIMIT) fail("QUOTA_EXHAUSTED", "Votre quota quotidien est épuisé. La modification n’a pas été persistée.");
      }
      continue;
    }
    if (state.pointer.stateKey) await deleteObject(state.pointer.stateKey).catch(() => undefined);
    await post(connection.connectionId, { type: "ack", updateId: message.updateId, version: nextDocumentVersion, epoch: state.pointer.epoch }).catch(() => undefined);
    await broadcastBinary(connection.documentId, "update", state.pointer.epoch, update, {
      updateId: message.updateId, writerId: connection.writerId,
    }, connection.connectionId);
    if (change.chargeable > 0) {
      const quota = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `QUOTA#${connection.writerId}#${quotaDay}`, SK: "COUNTER" }, ConsistentRead: true }));
      const used = Number(quota.Item?.used ?? 0);
      await post(connection.connectionId, { type: "quota", used, limit: DAILY_CHARACTER_LIMIT, remaining: Math.max(0, DAILY_CHARACTER_LIMIT - used), day: quotaDay }).catch(() => undefined);
    }
    return;
  }
  fail("DOCUMENT_BUSY", "D’autres modifications arrivent en même temps. Resynchronisez puis réessayez.");
}

async function handleMessage(connectionId: string, rawBody: string | null | undefined): Promise<void> {
  if (!rawBody || Buffer.byteLength(rawBody, "utf8") > 100_000) fail("INVALID_MESSAGE", "Le message est vide ou dépasse 100 Ko.");
  let message: Message;
  try {
    message = JSON.parse(rawBody) as Message;
  } catch {
    fail("INVALID_MESSAGE", "Le message doit être un objet JSON valide.");
  }
  if (!message || typeof message !== "object") fail("INVALID_MESSAGE", "Le message doit être un objet JSON valide.");
  const connection = await connectionFor(connectionId);
  if (!connection) fail("CONNECTION_EXPIRED", "La connexion a expiré. Reconnectez-vous.");
  await refreshConnection(connection);
  if (message.action === "ping") {
    await post(connectionId, { type: "pong", timestamp: Date.now() });
    return;
  }
  if (message.action === "sync") {
    const doc = await loadDoc(connection.documentId);
    const role = await findRole(connection.documentId, connection.writerId, doc);
    if (!role) fail("DOCUMENT_FORBIDDEN", "Votre accès au document a été retiré.");
    connection.role = role;
    const pointer = await loadPointer(connection.documentId);
    const reset = message.epoch !== undefined && message.epoch !== pointer?.epoch;
    await syncClient(connection, reset ? undefined : message.stateVector, reset);
    return;
  }
  if (message.action === "update") {
    await processUpdate(connection, message);
    return;
  }
  if (message.action === "cursor") {
    const position = typeof message.position === "number" ? message.position : 0;
    const line = typeof message.line === "number" ? message.line : 1;
    const col = typeof message.col === "number" ? message.col : 1;
    await broadcast(connection.documentId, {
      type: "cursor",
      writerId: connection.writerId,
      name: connection.name,
      position,
      line,
      col,
    }, connection.connectionId);
    return;
  }
  fail("UNKNOWN_ACTION", "Action WebSocket inconnue.");
}

export async function websocketHandler(event: WebSocketEvent): Promise<{ statusCode: number; body?: string }> {
  const connectionId = event.requestContext.connectionId;
  const routeKey = event.requestContext.routeKey;
  try {
    if (routeKey === "$connect") {
      if (!connectionId || !bucketName) return { statusCode: 503 };
      return { statusCode: await connect(event, connectionId) };
    }
    if (routeKey === "$disconnect") {
      if (connectionId) {
        const connection = await connectionFor(connectionId);
        await removeConnection(connectionId, connection?.documentId);
        if (connection) await broadcast(connection.documentId, { type: "presence", participants: await participantList(connection.documentId) }).catch(() => undefined);
      }
      return { statusCode: 200 };
    }
    if (!connectionId) return { statusCode: 400 };
    await handleMessage(connectionId, event.body);
    return { statusCode: 200 };
  } catch (error) {
    const code = (error as Error & { code?: string }).code ?? "COLLABORATION_ERROR";
    if (connectionId) {
      const message = (error as Error & { code?: string }).code
        ? (error as Error).message
        : "Une erreur serveur est survenue. Réessayez.";
      await post(connectionId, { type: "error", code, message }).catch(() => undefined);
    }
    if (code === "CONNECTION_EXPIRED") return { statusCode: 410 };
    return { statusCode: 200 };
  }
}
