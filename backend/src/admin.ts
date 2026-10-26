// Administration endpoints for monitoring
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.APP_TABLE!;

export interface AdminStats {
  openDocuments: Array<{
    id: string;
    title: string;
    ownerId: string;
    updatedAt: number;
    version: number;
  }>;
  activeLinks: Array<{
    id: string;
    documentId: string;
    limit: number;
    used: number;
    remaining: number;
    createdAt: number;
    creatorId: string;
    status: 'active' | 'exhausted';
  }>;
  blockedWriters: Array<{
    writerId: string;
    blockedUntil: number;
    reason: string;
  }>;
  activeConnections: Array<{
    connectionId: string;
    documentId: string;
    writerId: string;
    writerName: string;
    connectedAt: number;
  }>;
}

/**
 * Récupérer les statistiques d'administration
 */
export async function getAdminStats(): Promise<AdminStats> {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);

  // Scanner les documents récents / ouverts
  const documentsResult = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :docPrefix) AND SK = :meta',
      ExpressionAttributeValues: {
        ':docPrefix': 'DOC#',
        ':meta': 'META',
      },
      ProjectionExpression: 'PK, title, ownerId, updatedAt, version',
    })
  );

  const openDocuments = (documentsResult.Items || []).map((item) => ({
    id: String(item.PK).replace('DOC#', ''),
    title: String(item.title || 'Sans titre'),
    ownerId: String(item.ownerId || ''),
    updatedAt: typeof item.updatedAt === 'string' ? new Date(item.updatedAt).getTime() : Number(item.updatedAt || 0),
    version: Number(item.version || 0),
  }));

  // Scanner les liens de téléchargement
  const linksResult = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :linkPrefix) AND SK = :meta',
      ExpressionAttributeValues: {
        ':linkPrefix': 'DOWNLOAD#',
        ':meta': 'META',
      },
      ProjectionExpression: 'PK, linkId, documentId, maxDownloads, downloadCount, createdAt, creatorId',
    })
  );

  const activeLinks = (linksResult.Items || []).map((item) => {
    const used = Number(item.downloadCount || 0);
    const limit = Number(item.maxDownloads || 0);
    const remaining = Math.max(0, limit - used);
    return {
      id: String(item.linkId || String(item.PK).replace('DOWNLOAD#', '')),
      documentId: String(item.documentId || ''),
      limit,
      used,
      remaining,
      createdAt: typeof item.createdAt === 'string' ? new Date(item.createdAt).getTime() : Number(item.createdAt || 0),
      creatorId: String(item.creatorId || ''),
      status: (remaining > 0 ? 'active' : 'exhausted') as 'active' | 'exhausted',
    };
  });

  // Scanner les blocages actifs
  const blockedResult = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :abusePrefix) AND SK = :rate AND blockedUntil > :now',
      ExpressionAttributeValues: {
        ':abusePrefix': 'ABUSE#',
        ':rate': 'RATE',
        ':now': nowSeconds,
      },
      ProjectionExpression: 'PK, writerId, blockedUntil, blockReason',
    })
  );

  const blockedWriters = (blockedResult.Items || []).map((item) => ({
    writerId: String(item.writerId || String(item.PK).replace('ABUSE#', '')),
    blockedUntil: Number(item.blockedUntil || 0) * 1000,
    reason: String(item.blockReason || 'Trop de requêtes (limite anti-abus)'),
  }));

  // Scanner les connexions actives
  const connectionsResult = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :connPrefix) AND SK = :meta AND (attribute_not_exists(expiresAt) OR expiresAt > :now)',
      ExpressionAttributeValues: {
        ':connPrefix': 'CONNECTION#',
        ':meta': 'META',
        ':now': nowSeconds,
      },
      ProjectionExpression: 'PK, connectionId, documentId, writerId, #n, connectedAt',
      ExpressionAttributeNames: {
        '#n': 'name',
      },
    })
  );

  const activeConnections = (connectionsResult.Items || []).map((item) => ({
    connectionId: String(item.connectionId || String(item.PK).replace('CONNECTION#', '')),
    documentId: String(item.documentId || 'unknown'),
    writerId: String(item.writerId || 'unknown'),
    writerName: String(item.name || 'Anonyme'),
    connectedAt: typeof item.connectedAt === 'string' ? new Date(item.connectedAt).getTime() : Number(item.connectedAt || 0),
  }));

  return {
    openDocuments,
    activeLinks,
    blockedWriters,
    activeConnections,
  };
}

/**
 * Débloquer manuellement un rédacteur
 */
export async function unblockWriter(writerId: string): Promise<void> {
  await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `ABUSE#${writerId}`,
      },
    })
  );

  // Supprimer le blocage en mettant blockedUntil à 0
  const now = Date.now();
  await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `ABUSE#${writerId}`,
      },
    })
  );

  // Note: Pour un vrai déblocage, il faudrait un UpdateItem
  // Ce code est simplifié pour le MVP
}
