// API client pour communiquer avec le backend

import type { 
  Session, 
  Document, 
  DownloadLink, 
  Quota, 
  DocumentVersion, 
  Share,
  ApiError 
} from './types';

// URL de l'API - configurée via variable d'environnement ou localhost pour dev
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

class ApiClient {
  private getAuthHeaders(): HeadersInit {
    const token = localStorage.getItem('session_token');
    if (!token) {
      throw new Error('Non authentifié');
    }
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const error = await response.json() as { error: ApiError };
      throw new Error(error.error?.message || `Erreur ${response.status}`);
    }
    return response.json();
  }

  // Session et authentification
  async createSession(name: string, email: string): Promise<Session> {
    const response = await fetch(`${API_BASE_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    const session = await this.handleResponse<Session>(response);
    localStorage.setItem('session_token', session.token);
    localStorage.setItem('writer', JSON.stringify(session.writer));
    return session;
  }

  async getMe() {
    const response = await fetch(`${API_BASE_URL}/me`, {
      headers: this.getAuthHeaders(),
    });
    return this.handleResponse<{ writer: any }>(response);
  }

  // Quota
  async getQuota(): Promise<Quota> {
    const response = await fetch(`${API_BASE_URL}/quota`, {
      headers: this.getAuthHeaders(),
    });
    return this.handleResponse<Quota>(response);
  }

  // Documents
  async listDocuments(nextToken?: string): Promise<{ documents: Document[]; nextToken?: string }> {
    const url = nextToken 
      ? `${API_BASE_URL}/documents?nextToken=${encodeURIComponent(nextToken)}`
      : `${API_BASE_URL}/documents`;
    const response = await fetch(url, {
      headers: this.getAuthHeaders(),
    });
    return this.handleResponse<{ documents: Document[]; nextToken?: string }>(response);
  }

  async createDocument(title: string, content: string = ''): Promise<Document> {
    const response = await fetch(`${API_BASE_URL}/documents`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ title, content }),
    });
    return this.handleResponse<Document>(response);
  }

  async getDocument(id: string): Promise<Document> {
    const response = await fetch(`${API_BASE_URL}/documents/${id}`, {
      headers: this.getAuthHeaders(),
    });
    return this.handleResponse<Document>(response);
  }

  async updateDocument(id: string, content: string): Promise<Document> {
    const response = await fetch(`${API_BASE_URL}/documents/${id}`, {
      method: 'PUT',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ content }),
    });
    return this.handleResponse<Document>(response);
  }

  // Partage
  async shareDocument(documentId: string, writerId: string, role: 'editor' | 'viewer'): Promise<Share> {
    const response = await fetch(`${API_BASE_URL}/documents/${documentId}/shares`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ writerId, role }),
    });
    return this.handleResponse<Share>(response);
  }

  // WebSocket ticket
  async createWebSocketTicket(documentId: string): Promise<{ ticket: string; expiresAt: number }> {
    const response = await fetch(`${API_BASE_URL}/documents/${documentId}/ws-ticket`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
    });
    return this.handleResponse<{ ticket: string; expiresAt: number }>(response);
  }

  // Liens de téléchargement
  async createDownloadLink(documentId: string, limit: number): Promise<DownloadLink> {
    const response = await fetch(`${API_BASE_URL}/documents/${documentId}/download-links`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ maxDownloads: limit, limit }),
    });
    const result = await this.handleResponse<{ link: DownloadLink } | DownloadLink>(response);
    const link = 'link' in result ? result.link : result;
    return {
      ...link,
      limit: link.limit || link.maxDownloads || limit,
      used: link.used || 0,
      remaining: link.remaining !== undefined ? link.remaining : limit,
    };
  }

  async listDownloadLinks(documentId: string): Promise<{ links: DownloadLink[] }> {
    const response = await fetch(`${API_BASE_URL}/documents/${documentId}/download-links`, {
      headers: this.getAuthHeaders(),
    });
    return this.handleResponse<{ links: DownloadLink[] }>(response);
  }

  // Versions
  async listVersions(documentId: string): Promise<{ versions: DocumentVersion[] }> {
    const response = await fetch(`${API_BASE_URL}/documents/${documentId}/versions`, {
      headers: this.getAuthHeaders(),
    });
    return this.handleResponse<{ versions: DocumentVersion[] }>(response);
  }

  async createVersion(documentId: string, label?: string): Promise<DocumentVersion> {
    const response = await fetch(`${API_BASE_URL}/documents/${documentId}/versions`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ label }),
    });
    return this.handleResponse<DocumentVersion>(response);
  }

  async restoreVersion(documentId: string, snapshotId: string): Promise<Document> {
    const response = await fetch(`${API_BASE_URL}/documents/${documentId}/versions/${snapshotId}/restore`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
    });
    await this.handleResponse<{ restored: boolean }>(response);
    return this.getDocument(documentId);
  }

  // Téléchargement public
  async checkDownloadStatus(token: string): Promise<{ status: 'available' | 'exhausted'; remaining: number; maxDownloads: number; downloadCount: number }> {
    const response = await fetch(`${API_BASE_URL}/downloads/${encodeURIComponent(token)}?check=1`);
    if (!response.ok) {
      if (response.status === 410) {
        return { status: 'exhausted', remaining: 0, maxDownloads: 0, downloadCount: 0 };
      }
      const error = await response.json().catch(() => ({})) as { error?: ApiError };
      throw new Error(error.error?.message || `Erreur ${response.status}`);
    }
    return response.json();
  }

  async downloadDocument(secret: string): Promise<{ blob: Blob; remaining?: number }> {
    const response = await fetch(`${API_BASE_URL}/downloads/${encodeURIComponent(secret)}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: ApiError };
      const status = response.status;
      const msg = error.error?.message || (status === 410 ? 'Limite de téléchargements atteinte' : `Erreur ${status}`);
      const err = new Error(msg) as Error & { status?: number; retryAfter?: number };
      err.status = status;
      const retryHeader = response.headers.get('retry-after');
      if (retryHeader) err.retryAfter = parseInt(retryHeader, 10);
      throw err;
    }
    const remainingHeader = response.headers.get('x-download-remaining');
    const remaining = remainingHeader !== null ? parseInt(remainingHeader, 10) : undefined;
    const blob = await response.blob();
    return { blob, remaining };
  }

  // Vérifier si connecté
  isAuthenticated(): boolean {
    return !!localStorage.getItem('session_token');
  }

  getWriter() {
    const writer = localStorage.getItem('writer');
    return writer ? JSON.parse(writer) : null;
  }

  logout() {
    localStorage.removeItem('session_token');
    localStorage.removeItem('writer');
  }
}

export const api = new ApiClient();
