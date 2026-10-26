// Types partagés pour le frontend

export interface Writer {
  id: string;
  name: string;
  email: string;
}

export interface Session {
  token: string;
  writer: Writer;
  expiresAt: number;
}

export interface Document {
  id: string;
  ownerId: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  epoch: number;
}

export interface Share {
  writerId: string;
  role: 'editor' | 'viewer';
  sharedAt: number;
}

export interface DownloadLink {
  id: string;
  documentId: string;
  secret?: string;
  token?: string;
  limit: number;
  maxDownloads?: number;
  used: number;
  remaining?: number;
  createdAt: number;
  creatorId: string;
  url: string;
  status?: 'available' | 'exhausted';
}

export interface Quota {
  writerId: string;
  date: string;
  used: number;
  limit: number;
  remaining: number;
}

export interface DocumentVersion {
  snapshotId: string;
  documentId: string;
  version: number;
  label?: string;
  createdAt: number;
  createdBy: string;
}

export interface Connection {
  writerId: string;
  writerName: string;
  position?: number;
  line?: number;
  col?: number;
}

export interface ApiError {
  code: string;
  message: string;
}
