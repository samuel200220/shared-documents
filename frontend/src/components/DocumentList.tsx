import { useState, useEffect } from 'react';
import { api } from '../api';
import type { Document, Quota } from '../types';

interface DocumentListProps {
  onSelectDocument: (doc: Document) => void;
  loadError?: string;
}

export function DocumentList({ onSelectDocument, loadError = '' }: DocumentListProps) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newDocTitle, setNewDocTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const writer = api.getWriter();

  useEffect(() => {
    loadDocuments();
    loadQuota();
  }, []);

  const loadDocuments = async () => {
    try {
      setLoading(true);
      setError('');
      const result = await api.listDocuments();
      setDocuments(result.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  };

  const loadQuota = async () => {
    try {
      const q = await api.getQuota();
      setQuota(q);
    } catch (err) {
      console.error('Erreur chargement quota:', err);
    }
  };

  const handleCreateDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocTitle.trim()) return;

    try {
      setCreating(true);
      setError('');
      const doc = await api.createDocument(newDocTitle.trim());
      setDocuments([doc, ...documents]);
      setNewDocTitle('');
      setShowCreateForm(false);
      loadQuota(); // Recharger le quota après création
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de création');
    } finally {
      setCreating(false);
    }
  };

  const handleLogout = () => {
    api.logout();
    window.location.reload();
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('fr-FR', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const quotaPercentage = quota ? (quota.used / quota.limit) * 100 : 0;
  const quotaColor = quotaPercentage > 90 ? 'var(--danger)' : quotaPercentage > 70 ? 'var(--warning)' : 'var(--success)';

  return (
    <div className="page">
      <nav className="navbar">
        <h1>📝 Mes Documents</h1>
        <div className="navbar-actions">
          {quota && (
            <div className="navbar-info">
              <div style={{ fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                Quota d'écriture
              </div>
              <div style={{ fontWeight: '600', color: quotaColor }}>
                {quota.remaining} / {quota.limit} caractères
              </div>
            </div>
          )}
          <div className="navbar-info">
            <div style={{ fontWeight: '500' }}>{writer?.name}</div>
            <div>{writer?.email}</div>
          </div>
          <button onClick={handleLogout}>Déconnexion</button>
        </div>
      </nav>

      <div className="container" style={{ paddingTop: '2rem' }}>
        {loadError && (
          <div className="error" style={{ marginBottom: '1rem' }}>
            {loadError}
          </div>
        )}

        {error && (
          <div className="error" style={{ marginBottom: '1rem' }}>
            {error}
          </div>
        )}

        <div style={{ marginBottom: '2rem' }}>
          {!showCreateForm ? (
            <button className="primary" onClick={() => setShowCreateForm(true)}>
              + Nouveau document
            </button>
          ) : (
            <form onSubmit={handleCreateDocument} className="card">
              <h3 style={{ marginBottom: '1rem' }}>Créer un nouveau document</h3>
              <div className="form-group">
                <label htmlFor="title">Titre du document</label>
                <input
                  id="title"
                  type="text"
                  value={newDocTitle}
                  onChange={(e) => setNewDocTitle(e.target.value)}
                  placeholder="Mon nouveau document"
                  required
                  disabled={creating}
                  autoFocus
                />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="submit" className="primary" disabled={creating}>
                  {creating ? 'Création...' : 'Créer'}
                </button>
                <button type="button" onClick={() => setShowCreateForm(false)} disabled={creating}>
                  Annuler
                </button>
              </div>
            </form>
          )}
        </div>

        {loading ? (
          <div className="loading">
            <div className="spinner"></div>
          </div>
        ) : documents.length === 0 ? (
          <div className="card text-center">
            <p style={{ color: 'var(--text-muted)' }}>
              Aucun document pour le moment. Créez-en un pour commencer !
            </p>
          </div>
        ) : (
          <div className="list">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="list-item"
                onClick={() => onSelectDocument(doc)}
              >
                <div className="list-item-title">{doc.title}</div>
                <div className="list-item-meta">
                  {doc.ownerId === writer?.id && (
                    <span className="badge badge-success" style={{ marginRight: '0.5rem' }}>
                      Propriétaire
                    </span>
                  )}
                  Dernière modification : {formatDate(doc.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
