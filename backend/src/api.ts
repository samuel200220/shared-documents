import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { enforceAbuseLimit } from "./abuse.js";
import { getAdminStats } from "./admin.js";
import { reserveDownloadSlot } from "./downloads.js";
import { generatePdf, MAX_PDF_BYTES, PdfGenerationError } from "./pdf.js";
import { buildQuotaUpdate, DAILY_CHARACTER_LIMIT, measureTextChange } from "./quota.js";
import { restoreCollaborative, type VersionSnapshot } from "./websocket.js";

const MAX_DOCUMENT_BYTES = 180_000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const tableName = process.env.APP_TABLE ?? "SharedDocsLocal";
const bucketName = process.env.DOCUMENTS_BUCKET;
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ses = new SESClient({});
const NOTIFICATION_SENDER = process.env.SES_SENDER_EMAIL || "notifications@shared-docs.local";

async function sendLastDownloadEmail(toEmail: string, linkId: string, totalDownloads: number, documentId: string, documentTitle: string): Promise<void> {
  try {
    await ses.send(new SendEmailCommand({
      Source: NOTIFICATION_SENDER,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: {
          Data: `[Éditeur Collaboratif] Dernier téléchargement pour "${documentTitle}"`,
          Charset: "UTF-8",
        },
        Body: {
          Text: {
            Data: `Bonjour,\n\nVotre lien de téléchargement (ID: ${linkId}) pour le document "${documentTitle}" vient de distribuer son dernier exemplaire.\nLa limite autorisée de ${totalDownloads} exemplaires a été atteinte.\n\nCordialement,\nL'équipe du journal`,
            Charset: "UTF-8",
          },
        },
      },
    }));
    console.log(JSON.stringify({ level: "info", action: "SES_NOTIFICATION_SENT", toEmail, linkId, totalDownloads }));
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", action: "SES_NOTIFICATION_FAILED", toEmail, error: error instanceof Error ? error.message : String(error) }));
  }
}

interface DocumentRecord {
  PK: string;
  SK: "META";
  documentId: string;
  ownerId: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface ApiError extends Error {
  statusCode: number;
  code: string;
}

function fail(statusCode: number, code: string, message: string): never {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.code = code;
  throw error;
}

function response(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    body: JSON.stringify(body),
  };
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  const raw = event.body ?? "{}";
  if (Buffer.byteLength(raw, "utf8") > 250_000) fail(413, "REQUEST_TOO_LARGE", "La requête dépasse 250 Ko.");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    return parsed as Record<string, unknown>;
  } catch {
    fail(400, "INVALID_JSON", "Le corps de la requête doit être un objet JSON valide.");
  }
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    fail(400, "INVALID_INPUT", `Le champ ${field} est requis et limité à ${max} caractères.`);
  }
  return value.trim();
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function bearerToken(event: APIGatewayProxyEventV2): string | undefined {
  const value = event.headers.authorization ?? event.headers.Authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

async function authenticate(event: APIGatewayProxyEventV2): Promise<{ writerId: string; name: string; email: string }> {
  const token = bearerToken(event);
  if (!token || token.length < 40) fail(401, "SESSION_REQUIRED", "Une session rédacteur valide est requise.");
  const session = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `SESSION#${hashSecret(token)}`, SK: "META" },
    ConsistentRead: true,
  }));
  if (!session.Item || Number(session.Item.expiresAt) <= Math.floor(Date.now() / 1000)) {
    fail(401, "SESSION_EXPIRED", "Cette session a expiré. Identifiez-vous à nouveau.");
  }
  return {
    writerId: String(session.Item.writerId),
    name: String(session.Item.name),
    email: String(session.Item.email),
  };
}

function documentKey(documentId: string): { PK: string; SK: "META" } {
  return { PK: `DOC#${documentId}`, SK: "META" };
}

async function getDocument(documentId: string): Promise<DocumentRecord> {
  const result = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: documentKey(documentId),
    ConsistentRead: true,
  }));
  if (!result.Item) fail(404, "DOCUMENT_NOT_FOUND", "Ce document n’existe pas.");
  return result.Item as unknown as DocumentRecord;
}

async function roleFor(documentId: string, writerId: string, doc: DocumentRecord): Promise<"owner" | "editor" | "viewer" | null> {
  if (doc.ownerId === writerId) return "owner";
  const result = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `DOC#${documentId}`, SK: `ACL#${writerId}` },
    ConsistentRead: true,
  }));
  return result.Item?.role === "editor" || result.Item?.role === "viewer" ? result.Item.role : null;
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createSession(body: Record<string, unknown>): Promise<APIGatewayProxyStructuredResultV2> {
  const name = requiredString(body.name, "name", 80);
  const email = requiredString(body.email, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "INVALID_EMAIL", "L’adresse e-mail n’est pas valide.");
  const writerId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await dynamo.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: tableName, Item: { PK: `WRITER#${writerId}`, SK: "PROFILE", writerId, name, email, createdAt: now }, ConditionExpression: "attribute_not_exists(PK)" } },
      { Put: { TableName: tableName, Item: { PK: `SESSION#${hashSecret(token)}`, SK: "META", writerId, name, email, expiresAt }, ConditionExpression: "attribute_not_exists(PK)" } },
    ],
  }));
  return response(201, {
    writer: { id: writerId, name, email },
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    identityNotice: "Le nom et l’adresse e-mail ne prouvent pas l’identité de la personne.",
  });
}

async function listDocuments(writerId: string, encodedCursor?: string): Promise<APIGatewayProxyStructuredResultV2> {
  let cursor: Record<string, unknown> | undefined;
  if (encodedCursor) {
    try {
      cursor = JSON.parse(Buffer.from(encodedCursor, "base64url").toString("utf8")) as Record<string, unknown>;
      if (cursor.PK !== `WRITER#${writerId}` || typeof cursor.SK !== "string") throw new Error("invalid cursor");
    } catch {
      fail(400, "INVALID_PAGE_TOKEN", "Le jeton de pagination est invalide.");
    }
  }
  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `WRITER#${writerId}`, ":prefix": "DOC#" },
    Limit: 100,
    ExclusiveStartKey: cursor,
  }));
  const indexes = result.Items ?? [];
  const ids = indexes.map((item) => String(item.documentId));
  const roles = new Map(indexes.map((item) => [String(item.documentId), String(item.role)]));
  if (!ids.length) return response(200, { documents: [], nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url") : null });
  const keys = ids.map(documentKey);
  let batch = await dynamo.send(new BatchGetCommand({
    RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } },
  }));
  const documentItems = [...(batch.Responses?.[tableName] ?? [])];
  let unprocessed = batch.UnprocessedKeys?.[tableName]?.Keys ?? [];
  for (let attempt = 0; unprocessed.length > 0 && attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    batch = await dynamo.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: unprocessed, ConsistentRead: true } } }));
    documentItems.push(...(batch.Responses?.[tableName] ?? []));
    unprocessed = batch.UnprocessedKeys?.[tableName]?.Keys ?? [];
  }
  if (unprocessed.length > 0) fail(503, "DOCUMENT_LIST_THROTTLED", "La liste est temporairement indisponible. Réessayez.");
  const docs = documentItems.map((item) => ({
    id: item.documentId,
    title: item.title,
    ownerId: item.ownerId,
    version: item.version,
    updatedAt: item.updatedAt,
    role: item.ownerId === writerId ? "owner" : roles.get(String(item.documentId)),
  }));
  return response(200, { documents: docs, nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url") : null });
}

async function readQuota(writerId: string): Promise<APIGatewayProxyStructuredResultV2> {
  const day = dayKey();
  const result = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `QUOTA#${writerId}#${day}`, SK: "COUNTER" },
    ConsistentRead: true,
  }));
  const used = Number(result.Item?.used ?? 0);
  return response(200, { limit: DAILY_CHARACTER_LIMIT, used, remaining: Math.max(0, DAILY_CHARACTER_LIMIT - used), day, timezone: "UTC" });
}

async function createDocument(writerId: string, body: Record<string, unknown>): Promise<APIGatewayProxyStructuredResultV2> {
  const quotaDay = dayKey();
  const title = requiredString(body.title, "title", 160);
  const content = typeof body.content === "string" ? body.content : "";
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) fail(413, "DOCUMENT_TOO_LARGE", "Le document dépasse 180 Ko.");
  const initialCharge = Array.from(content).length;
  if (initialCharge > DAILY_CHARACTER_LIMIT) fail(429, "QUOTA_EXHAUSTED", "Le contenu initial dépasse votre quota quotidien de rédaction.");
  const documentId = randomUUID();
  const now = new Date().toISOString();
  const item: DocumentRecord = {
    ...documentKey(documentId), documentId, ownerId: writerId, title, content,
    version: 1, createdAt: now, updatedAt: now,
  };
  const transactions: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]>["TransactItems"] = [
      { Put: { TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(PK)" } },
      { Put: { TableName: tableName, Item: { PK: `WRITER#${writerId}`, SK: `DOC#${documentId}`, documentId, role: "owner", updatedAt: now }, ConditionExpression: "attribute_not_exists(PK)" } },
      ...(initialCharge > 0 ? [buildQuotaUpdate(writerId, quotaDay, initialCharge, now, tableName)] : []),
    ];
  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactions }));
  } catch (error) {
    if (initialCharge > 0 && error instanceof Error && error.name === "TransactionCanceledException") {
      const quota = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `QUOTA#${writerId}#${quotaDay}`, SK: "COUNTER" }, ConsistentRead: true }));
      if (Number(quota.Item?.used ?? 0) + initialCharge > DAILY_CHARACTER_LIMIT) {
        fail(429, "QUOTA_EXHAUSTED", "Votre quota quotidien de rédaction est épuisé.");
      }
    }
    throw error;
  }
  const quota = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `QUOTA#${writerId}#${quotaDay}`, SK: "COUNTER" }, ConsistentRead: true }));
  const used = Number(quota.Item?.used ?? 0);
  return response(201, { document: item, quota: { limit: DAILY_CHARACTER_LIMIT, used, remaining: Math.max(0, DAILY_CHARACTER_LIMIT - used), day: quotaDay } });
}

async function readDocument(writerId: string, documentId: string): Promise<APIGatewayProxyStructuredResultV2> {
  const document = await getDocument(documentId);
  const role = await roleFor(documentId, writerId, document);
  if (!role) fail(403, "DOCUMENT_FORBIDDEN", "Vous n’avez pas accès à ce document.");
  return response(200, { document, role });
}

async function editDocument(writerId: string, documentId: string, body: Record<string, unknown>): Promise<APIGatewayProxyStructuredResultV2> {
  const quotaDay = dayKey();
  const document = await getDocument(documentId);
  const role = await roleFor(documentId, writerId, document);
  if (role !== "owner" && role !== "editor") fail(403, "DOCUMENT_READ_ONLY", "Vous ne pouvez pas modifier ce document.");
  const content = typeof body.content === "string" ? body.content : fail(400, "INVALID_INPUT", "Le contenu est requis.");
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) fail(413, "DOCUMENT_TOO_LARGE", "Le document dépasse 180 Ko.");
  const change = measureTextChange(document.content, content);
  if (content === document.content) {
    const quota = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `QUOTA#${writerId}#${quotaDay}`, SK: "COUNTER" }, ConsistentRead: true }));
    const used = Number(quota.Item?.used ?? 0);
    return response(200, { document, change, quota: { limit: DAILY_CHARACTER_LIMIT, used, remaining: Math.max(0, DAILY_CHARACTER_LIMIT - used), day: quotaDay } });
  }
  const now = new Date().toISOString();
  const nextVersion = document.version + 1;
  const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]>["TransactItems"] = [
    { Update: {
      TableName: tableName,
      Key: documentKey(documentId),
      UpdateExpression: "SET content = :content, version = :next, updatedAt = :now",
      ConditionExpression: "version = :expected",
      ExpressionAttributeValues: { ":content": content, ":next": nextVersion, ":now": now, ":expected": document.version },
    } },
    { ConditionCheck: {
      TableName: tableName,
      Key: { PK: `DOC#${documentId}`, SK: "CRDT#STATE" },
      ConditionExpression: "attribute_not_exists(PK)",
    } },
  ];
  if (change.chargeable > 0) {
    writes.push(buildQuotaUpdate(writerId, quotaDay, change.chargeable, now, tableName));
  }
  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      const collabState = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `DOC#${documentId}`, SK: "CRDT#STATE" }, ConsistentRead: true }));
      if (collabState.Item) fail(409, "COLLABORATION_ACTIVE", "Le document est en mode collaboratif. Modifiez-le depuis une session collaborative.");
      const quota = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `QUOTA#${writerId}#${quotaDay}`, SK: "COUNTER" }, ConsistentRead: true }));
      const used = Number(quota.Item?.used ?? 0);
      if (change.chargeable > 0 && used + change.chargeable > DAILY_CHARACTER_LIMIT) {
        fail(429, "QUOTA_EXHAUSTED", "Votre quota quotidien de rédaction est épuisé.");
      }
      fail(409, "DOCUMENT_CHANGED", "Le document a changé depuis sa lecture. Rechargez-le avant de réessayer.");
    }
    throw error;
  }
  const quota = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `QUOTA#${writerId}#${quotaDay}`, SK: "COUNTER" }, ConsistentRead: true }));
  const used = Number(quota.Item?.used ?? 0);
  return response(200, {
    document: { ...document, content, version: nextVersion, updatedAt: now },
    change,
    quota: { limit: DAILY_CHARACTER_LIMIT, used, remaining: Math.max(0, DAILY_CHARACTER_LIMIT - used), day: quotaDay },
  });
}

async function shareDocument(writerId: string, documentId: string, body: Record<string, unknown>): Promise<APIGatewayProxyStructuredResultV2> {
  const targetWriterId = requiredString(body.writerId, "writerId", 80);
  const role = body.role === "viewer" ? "viewer" : body.role === "editor" ? "editor" : fail(400, "INVALID_ROLE", "Le rôle doit être editor ou viewer.");
  const document = await getDocument(documentId);
  if (document.ownerId !== writerId) fail(403, "OWNER_REQUIRED", "Seul le propriétaire peut gérer les accès.");
  if (targetWriterId === writerId) fail(400, "INVALID_SHARE", "Le propriétaire possède déjà l’accès au document.");
  const target = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `WRITER#${targetWriterId}`, SK: "PROFILE" }, ConsistentRead: true }));
  if (!target.Item) fail(404, "WRITER_NOT_FOUND", "Ce rédacteur n’existe pas.");
  const now = new Date().toISOString();
  await dynamo.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: tableName, Item: { PK: `DOC#${documentId}`, SK: `ACL#${targetWriterId}`, writerId: targetWriterId, role, grantedBy: writerId, createdAt: now } } },
      { Put: { TableName: tableName, Item: { PK: `WRITER#${targetWriterId}`, SK: `DOC#${documentId}`, documentId, role, updatedAt: now } } },
    ],
  }));
  return response(201, { documentId, writerId: targetWriterId, role });
}

async function createWebSocketTicket(writerId: string, documentId: string): Promise<APIGatewayProxyStructuredResultV2> {
  const document = await getDocument(documentId);
  const role = await roleFor(documentId, writerId, document);
  if (!role) fail(403, "DOCUMENT_FORBIDDEN", "Vous n’avez pas accès à ce document.");
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const profile = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `WRITER#${writerId}`, SK: "PROFILE" }, ConsistentRead: true }));
  await dynamo.send(new PutCommand({
    TableName: tableName,
    Item: { PK: `WSTICKET#${hashSecret(ticket)}`, SK: "META", writerId, name: profile.Item?.name ?? "", documentId, role, expiresAt },
    ConditionExpression: "attribute_not_exists(PK)",
  }));
  return response(201, { ticket, expiresAt: new Date(expiresAt * 1000).toISOString() });
}

function createSnapshotId(): string {
  return `${Date.now().toString().padStart(13, "0")}-${randomUUID()}`;
}

function publicVersion(snapshot: VersionSnapshot) {
  return {
    id: snapshot.snapshotId,
    documentVersion: snapshot.documentVersion,
    createdAt: snapshot.createdAt,
    createdBy: snapshot.createdBy,
    title: snapshot.title,
    label: snapshot.label,
    restoredFrom: snapshot.restoredFrom,
  };
}

async function createVersion(writerId: string, documentId: string, body: Record<string, unknown>): Promise<APIGatewayProxyStructuredResultV2> {
  const document = await getDocument(documentId);
  const role = await roleFor(documentId, writerId, document);
  if (role !== "owner" && role !== "editor") fail(403, "DOCUMENT_READ_ONLY", "Vous ne pouvez pas enregistrer une version.");
  if (!bucketName) fail(503, "STORAGE_NOT_CONFIGURED", "Le stockage des versions n’est pas configuré.");
  const label = typeof body.label === "string" ? requiredString(body.label, "label", 100) : undefined;
  const snapshotId = createSnapshotId();
  const s3Key = `versions/${documentId}/${snapshotId}.txt`;
  const createdAt = new Date().toISOString();
  const snapshot: VersionSnapshot = {
    PK: `DOC#${documentId}`, SK: `VERSION#${snapshotId}`, snapshotId,
    documentVersion: document.version, s3Key, createdAt, createdBy: writerId,
    title: document.title, ...(label ? { label } : {}),
  };
  await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: s3Key, Body: Buffer.from(document.content, "utf8"), ContentType: "text/plain; charset=utf-8", ServerSideEncryption: "AES256" }));
  try {
    await dynamo.send(new PutCommand({ TableName: tableName, Item: snapshot, ConditionExpression: "attribute_not_exists(PK)" }));
  } catch (error) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: s3Key })).catch(() => undefined);
    throw error;
  }
  return response(201, { version: publicVersion(snapshot) });
}

async function listVersions(writerId: string, documentId: string, encodedCursor?: string): Promise<APIGatewayProxyStructuredResultV2> {
  const document = await getDocument(documentId);
  if (!await roleFor(documentId, writerId, document)) fail(403, "DOCUMENT_FORBIDDEN", "Vous n’avez pas accès à cet historique.");
  let cursor: Record<string, unknown> | undefined;
  if (encodedCursor) {
    try {
      cursor = JSON.parse(Buffer.from(encodedCursor, "base64url").toString("utf8")) as Record<string, unknown>;
      if (cursor.PK !== `DOC#${documentId}` || typeof cursor.SK !== "string" || !cursor.SK.startsWith("VERSION#")) throw new Error("bad cursor");
    } catch {
      fail(400, "INVALID_PAGE_TOKEN", "Le jeton de pagination est invalide.");
    }
  }
  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `DOC#${documentId}`, ":prefix": "VERSION#" },
    ExclusiveStartKey: cursor,
    ScanIndexForward: false,
    Limit: 100,
  }));
  return response(200, {
    versions: (result.Items ?? []).map((item) => publicVersion(item as unknown as VersionSnapshot)),
    nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url") : null,
  });
}

async function restoreVersion(writerId: string, documentId: string, snapshotId: string): Promise<APIGatewayProxyStructuredResultV2> {
  const document = await getDocument(documentId);
  const role = await roleFor(documentId, writerId, document);
  if (role !== "owner" && role !== "editor") fail(403, "DOCUMENT_READ_ONLY", "Vous ne pouvez pas restaurer cette version.");
  if (!bucketName) fail(503, "STORAGE_NOT_CONFIGURED", "Le stockage des versions n’est pas configuré.");
  const previous = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `DOC#${documentId}`, SK: `VERSION#${snapshotId}` }, ConsistentRead: true }));
  if (!previous.Item) fail(404, "VERSION_NOT_FOUND", "Cette version n’existe pas.");
  const oldFile = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: String(previous.Item.s3Key) }));
  const oldBytes = await oldFile.Body?.transformToByteArray();
  if (!oldBytes) fail(503, "VERSION_UNAVAILABLE", "Le contenu de cette version est indisponible.");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(oldBytes);
  } catch {
    fail(503, "VERSION_CORRUPT", "Le contenu de cette version est invalide.");
  }
  const newSnapshotId = createSnapshotId();
  const s3Key = `versions/${documentId}/${newSnapshotId}.txt`;
  const now = new Date().toISOString();
  const snapshot: VersionSnapshot = {
    PK: `DOC#${documentId}`, SK: `VERSION#${newSnapshotId}`, snapshotId: newSnapshotId,
    documentVersion: document.version + 1, s3Key, createdAt: now, createdBy: writerId,
    title: document.title, restoredFrom: snapshotId, label: `Restauration de ${String(previous.Item.label ?? snapshotId)}`,
  };
  await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: s3Key, Body: Buffer.from(content, "utf8"), ContentType: "text/plain; charset=utf-8", ServerSideEncryption: "AES256" }));
  try {
    const result = await restoreCollaborative(documentId, writerId, content, snapshot);
    return response(201, { restored: true, version: publicVersion(snapshot), documentVersion: result.version, epoch: result.epoch });
  } catch (error) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: s3Key })).catch(() => undefined);
    throw error;
  }
}

async function createDownloadLink(writerId: string, documentId: string, body: Record<string, unknown>): Promise<APIGatewayProxyStructuredResultV2> {
  const maxDownloads = Number(body.maxDownloads ?? body.limit);
  if (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > 10_000) {
    fail(400, "INVALID_DOWNLOAD_LIMIT", "La limite doit être un entier entre 1 et 10 000.");
  }
  const document = await getDocument(documentId);
  const role = await roleFor(documentId, writerId, document);
  if (role !== "owner" && role !== "editor") fail(403, "DOCUMENT_READ_ONLY", "Vous ne pouvez pas créer de lien pour ce document.");
  if (!bucketName) fail(503, "STORAGE_NOT_CONFIGURED", "Le stockage des PDF n’est pas configuré.");
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashSecret(rawToken);
  const linkId = randomUUID();
  const now = new Date().toISOString();
  const creator = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `WRITER#${writerId}`, SK: "PROFILE" }, ConsistentRead: true }));
  await dynamo.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: tableName, Item: {
        PK: `DOWNLOAD#${tokenHash}`, SK: "META", linkId, documentId, creatorId: writerId,
        creatorEmail: creator.Item?.email,
        maxDownloads: Number(maxDownloads), downloadCount: 0,
        createdAt: now, lastNotificationSent: false,
      }, ConditionExpression: "attribute_not_exists(PK)" } },
      { Put: { TableName: tableName, Item: {
        PK: `DOC#${documentId}`,
        SK: `LINK#${linkId}`,
        tokenHash,
        rawToken,
        maxDownloads: Number(maxDownloads),
        downloadCount: 0,
        createdAt: now
      }, ConditionExpression: "attribute_not_exists(PK)" } },
    ],
  }));
  return response(201, {
    link: {
      id: linkId,
      token: rawToken,
      urlPath: `/downloads/${rawToken}`,
      url: `${process.env.API_GATEWAY_URL || ""}/downloads/${rawToken}`,
      limit: Number(maxDownloads),
      maxDownloads: Number(maxDownloads),
      used: 0,
      remaining: Number(maxDownloads),
      status: "available",
      createdAt: new Date(now).getTime(),
    },
  });
}

async function listDownloadLinks(writerId: string, documentId: string): Promise<APIGatewayProxyStructuredResultV2> {
  const document = await getDocument(documentId);
  const role = await roleFor(documentId, writerId, document);
  if (!role) fail(403, "DOCUMENT_ACCESS_DENIED", "Vous n'avez pas accès à ce document.");
  
  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": `DOC#${documentId}`, ":prefix": "LINK#" },
  }));

  const links = (result.Items || []).map((item) => {
    const token = item.rawToken || item.tokenHash;
    const limit = Number(item.maxDownloads || 0);
    const used = Number(item.downloadCount || 0);
    return {
      id: String(item.SK).substring(5), // Remove "LINK#" prefix
      documentId,
      limit,
      maxDownloads: limit,
      used,
      remaining: Math.max(0, limit - used),
      createdAt: typeof item.createdAt === "string" ? new Date(item.createdAt).getTime() : Number(item.createdAt || 0),
      creatorId: writerId,
      token,
      url: `${process.env.API_GATEWAY_URL || ""}/downloads/${token}`,
    };
  });

  return response(200, { links });
}

async function publicDownload(rawToken: string, isCheckOnly = false): Promise<APIGatewayProxyStructuredResultV2> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(rawToken)) fail(404, "DOWNLOAD_NOT_FOUND", "Ce lien n’existe pas.");
  if (!bucketName) fail(503, "STORAGE_NOT_CONFIGURED", "Le stockage des PDF n’est pas configuré.");
  const tokenHash = hashSecret(rawToken);

  if (isCheckOnly) {
    const link = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `DOWNLOAD#${tokenHash}`, SK: "META" }, ConsistentRead: true }));
    if (!link.Item) fail(404, "DOWNLOAD_NOT_FOUND", "Ce lien n'existe pas.");
    const maxDownloads = Number(link.Item.maxDownloads || 0);
    const downloadCount = Number(link.Item.downloadCount || 0);
    const remaining = Math.max(0, maxDownloads - downloadCount);
    if (downloadCount >= maxDownloads) {
      return response(410, {
        status: "exhausted",
        message: "La limite de téléchargements de ce lien est atteinte.",
        maxDownloads,
        downloadCount,
        remaining: 0,
      });
    }
    return response(200, {
      status: "available",
      maxDownloads,
      downloadCount,
      remaining,
    });
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const link = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `DOWNLOAD#${tokenHash}`, SK: "META" }, ConsistentRead: true }));
    if (!link.Item) fail(404, "DOWNLOAD_NOT_FOUND", "Ce lien n’existe pas.");
    const documentId = String(link.Item.documentId);
    const document = await dynamo.send(new GetCommand({ TableName: tableName, Key: documentKey(documentId), ConsistentRead: true }));
    if (!document.Item) fail(404, "DOCUMENT_NOT_FOUND", "Le document associé à ce lien n’existe plus.");
    const current = document.Item as unknown as DocumentRecord;
    let pdfBytes: Uint8Array;
    try {
      pdfBytes = await generatePdf(current.title, current.content);
    } catch (error) {
      if (error instanceof PdfGenerationError) fail(error.code === "PDF_TOO_LARGE" ? 413 : 422, error.code, error.message);
      throw error;
    }

    // Write the exact revision being reserved to private S3 storage first. The
    // transaction below only consumes a slot if that revision is still current.
    const objectKey = `downloads/${tokenHash}/${randomUUID()}.pdf`;
    await s3.send(new PutObjectCommand({
      Bucket: bucketName, Key: objectKey, Body: pdfBytes, ContentType: "application/pdf",
      ServerSideEncryption: "AES256", Metadata: { documentversion: String(current.version), linkid: String(link.Item.linkId) },
    }));
    try {
      await reserveDownloadSlot((command) => dynamo.send(command), tableName, tokenHash, documentId, current.version);
    } catch (error) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey })).catch(() => undefined);
      if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
      const latestLink = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `DOWNLOAD#${tokenHash}`, SK: "META" }, ConsistentRead: true }));
      if (!latestLink.Item) fail(404, "DOWNLOAD_NOT_FOUND", "Ce lien n’existe pas.");
      if (Number(latestLink.Item.downloadCount ?? 0) >= Number(latestLink.Item.maxDownloads)) {
        fail(410, "DOWNLOAD_LIMIT_REACHED", "La limite de téléchargements de ce lien est atteinte.");
      }
      continue;
    }

    const updatedLink = await dynamo.send(new GetCommand({ TableName: tableName, Key: { PK: `DOWNLOAD#${tokenHash}`, SK: "META" }, ConsistentRead: true }));
    const maxDownloads = Number(updatedLink.Item?.maxDownloads ?? link.Item.maxDownloads);
    const downloadCount = Number(updatedLink.Item?.downloadCount ?? 0);
    const remaining = Math.max(0, maxDownloads - downloadCount);

    // Notification SES au créateur lors du dernier exemplaire distribué
    if (downloadCount >= maxDownloads && !updatedLink.Item?.lastNotificationSent && updatedLink.Item?.creatorEmail) {
      await sendLastDownloadEmail(
        String(updatedLink.Item.creatorEmail),
        String(link.Item.linkId || link.Item.PK),
        maxDownloads,
        documentId,
        current.title
      ).catch(() => undefined);

      await dynamo.send(new UpdateCommand({
        TableName: tableName,
        Key: { PK: `DOWNLOAD#${tokenHash}`, SK: "META" },
        UpdateExpression: "SET lastNotificationSent = :true",
        ExpressionAttributeValues: { ":true": true },
      })).catch(() => undefined);
    }

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="document-${current.version}.pdf"`,
        "cache-control": "no-store",
        "x-download-remaining": String(remaining),
      },
      body: Buffer.from(pdfBytes).toString("base64"),
      isBase64Encoded: true,
    };
  }
  fail(503, "DOWNLOAD_BUSY", "Le document ou le lien change. Réessayez dans un instant.");
}

/**
 * Vérifier le secret administrateur
 * En production, utiliser AWS Secrets Manager
 */
function authenticateAdmin(event: APIGatewayProxyEventV2): void {
  const adminSecret = process.env.ADMIN_SECRET || "changeme";
  const provided = bearerToken(event);
  if (!provided || provided !== adminSecret) {
    fail(403, "ADMIN_REQUIRED", "Accès administrateur requis.");
  }
}

/**
 * Route admin : statistiques globales
 */
async function getAdminStatsHandler(): Promise<APIGatewayProxyStructuredResultV2> {
  const stats = await getAdminStats();
  return response(200, stats);
}

export async function apiHandler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = decodeURIComponent(event.rawPath).replace(/\/$/, "") || "/";
    
    // Gérer les requêtes OPTIONS (CORS preflight) AVANT toute authentification
    if (method === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "access-control-allow-origin": event.headers.origin || "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "authorization,content-type,x-request-id",
          "access-control-max-age": "300",
        },
        body: "",
      };
    }
    
    if (method === "GET" && path === "/health") return response(200, { status: "ok", service: "shared-docs-editor", region: process.env.AWS_REGION ?? "local" });
    if (method === "POST" && path === "/sessions") return await createSession(parseBody(event));
    if (method === "GET" && path.startsWith("/downloads/")) {
      const token = path.slice("/downloads/".length);
      const isCheckOnly = event.queryStringParameters?.check === "1" || event.queryStringParameters?.check === "true" || event.queryStringParameters?.status === "1";
      return await publicDownload(token, isCheckOnly);
    }
    
    // Routes admin protégées
    if (path.startsWith("/admin/")) {
      authenticateAdmin(event);
      if (method === "GET" && path === "/admin/stats") return await getAdminStatsHandler();
      return response(404, { error: { code: "NOT_FOUND", message: "Route admin non trouvée." } });
    }

    const identity = await authenticate(event);
    if (method !== "GET" && method !== "HEAD" && path !== "/health") {
      await enforceAbuseLimit((command) => dynamo.send(command as never), tableName, identity.writerId);
    }
    if (method === "GET" && path === "/me") return response(200, { writer: { id: identity.writerId, name: identity.name, email: identity.email } });
    if (method === "GET" && path === "/quota") return await readQuota(identity.writerId);
    if (method === "GET" && path === "/documents") return await listDocuments(identity.writerId, event.queryStringParameters?.nextToken);
    if (method === "POST" && path === "/documents") return await createDocument(identity.writerId, parseBody(event));

    const shareMatch = path.match(/^\/documents\/([^/]+)\/shares$/);
    if (method === "POST" && shareMatch) return await shareDocument(identity.writerId, shareMatch[1], parseBody(event));
    const linkMatch = path.match(/^\/documents\/([^/]+)\/download-links$/);
    if (method === "GET" && linkMatch) return await listDownloadLinks(identity.writerId, linkMatch[1]);
    if (method === "POST" && linkMatch) return await createDownloadLink(identity.writerId, linkMatch[1], parseBody(event));
    const ticketMatch = path.match(/^\/documents\/([^/]+)\/ws-ticket$/);
    if (method === "POST" && ticketMatch) return await createWebSocketTicket(identity.writerId, ticketMatch[1]);
    const restoreMatch = path.match(/^\/documents\/([^/]+)\/versions\/([^/]+)\/restore$/);
    if (method === "POST" && restoreMatch) return await restoreVersion(identity.writerId, restoreMatch[1], restoreMatch[2]);
    const versionsMatch = path.match(/^\/documents\/([^/]+)\/versions$/);
    if (versionsMatch && method === "GET") return await listVersions(identity.writerId, versionsMatch[1], event.queryStringParameters?.nextToken);
    if (versionsMatch && method === "POST") return await createVersion(identity.writerId, versionsMatch[1], parseBody(event));
    const documentMatch = path.match(/^\/documents\/([^/]+)$/);
    if (documentMatch && method === "GET") return await readDocument(identity.writerId, documentMatch[1]);
    if (documentMatch && (method === "PUT" || method === "PATCH")) return await editDocument(identity.writerId, documentMatch[1], parseBody(event));
    return response(404, { error: { code: "NOT_FOUND", message: "Cette route n’existe pas." } });
  } catch (error) {
    const typed = error as Partial<ApiError>;
    const statusCode = typed.statusCode ?? (typed.code === "QUOTA_EXHAUSTED" ? 429 : typed.code === "DOCUMENT_BUSY" ? 409 : 500);
    const code = typed.code ?? "INTERNAL_ERROR";
    const retryAfterSeconds = (typed as Partial<ApiError> & { retryAfterSeconds?: number }).retryAfterSeconds;
    if (statusCode >= 500) console.error(JSON.stringify({ level: "error", code, name: error instanceof Error ? error.name : "unknown" }));
    return response(statusCode, {
      error: { code, message: statusCode === 500 ? "Une erreur interne est survenue." : typed.message },
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    }, retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {});
  }
}
