import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import type { Document, DownloadLink, DocumentVersion, Quota } from '../types';
import { useCollaboration } from '../hooks/useCollaboration';

interface CollaborativeEditorProps {
  document: Document;
  onBack: () => void;
}

const WS_URL = import.meta.env.VITE_WS_URL || 'wss://2cteriqo04.execute-api.eu-north-1.amazonaws.com/dev';

export function CollaborativeEditor({ document: initialDoc, onBack }: CollaborativeEditorProps) {
  const [document, setDocument] = useState(initialDoc);
  const [content, setContent] = useState(initialDoc.content);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [useRealtime, setUseRealtime] = useState(true);
  
  // État pour les fonctionnalités
  const [showShareForm, setShowShareForm] = useState(false);
  const [showDownloadForm, setShowDownloadForm] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showLinksList, setShowLinksList] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [downloadLinks, setDownloadLinks] = useState<DownloadLink[]>([]);
  
  const [shareWriterId, setShareWriterId] = useState('');
  const [shareRole, setShareRole] = useState<'editor' | 'viewer'>('editor');
  const [downloadLimit, setDownloadLimit] = useState(500);
  const [versionLabel, setVersionLabel] = useState('');

  const writer = api.getWriter();
  const isOwner = document.ownerId === writer?.id;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Collaboration temps réel
  const collaboration = useCollaboration({
    documentId: document.id,
    websocketUrl: WS_URL,
    ticket: ticket || '',
    initialContent: document.content,
    onContentChange: (newContent) => {
      setContent(newContent);
    },
    onQuotaChange: (q) => {
      setQuota((prev) =>
        prev
          ? { ...prev, used: q.used, remaining: q.remaining, limit: q.limit }
          : { writerId: writer?.id || '', date: q.day, used: q.used, limit: q.limit, remaining: q.remaining }
      );
    },
    onError: (err) => {
      console.error('Erreur collaboration:', err);
      setError(err);
    },
  });

  const handleCursorActivity = () => {
    if (!textareaRef.current) return;
    const pos = textareaRef.current.selectionStart || 0;
    const textBefore = (textareaRef.current.value || content).slice(0, pos);
    const lines = textBefore.split('\n');
    const line = lines.length;
    const col = lines[lines.length - 1].length + 1;
    collaboration.updateCursor(pos, line, col);
  };

  useEffect(() => {
    loadQuota();
    loadWebSocketTicket();
    if (isOwner) {
      loadDownloadLinks();
    }
  }, []);

  const loadQuota = async () => {
    try {
      const q = await api.getQuota();
      setQuota(q);
    } catch (err) {
      console.error('Erreur quota:', err);
    }
  };

  const loadWebSocketTicket = async () => {
    try {
      const result = await api.createWebSocketTicket(document.id);
      setTicket(result.ticket);
    } catch (err) {
      console.error('Erreur ticket WebSocket:', err);
      setError('Impossible d\'activer la collaboration temps réel');
    }
  };

  const loadDownloadLinks = async () => {
    try {
      const result = await api.listDownloadLinks(document.id);
      setDownloadLinks(result.links);
    } catch (err) {
      console.error('Erreur chargement liens:', err);
    }
  };

  const handleSave = async () => {
    if (content === document.content) {
      setSuccess('Aucune modification à enregistrer');
      setTimeout(() => setSuccess(''), 2000);
      return;
    }

    try {
      setIsSaving(true);
      setError('');
      setSuccess('');
      const updated = await api.updateDocument(document.id, content);
      setDocument(updated);
      setSuccess('Document enregistré !');
      loadQuota();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur d\'enregistrement');
    } finally {
      setIsSaving(false);
    }
  };

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    if (useRealtime && collaboration.isConnected) {
      collaboration.updateContent(newContent);
    }
  };

  const handleShare = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError('');
      await api.shareDocument(document.id, shareWriterId, shareRole);
      setSuccess('Document partagé avec succès !');
      setShowShareForm(false);
      setShareWriterId('');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de partage');
    }
  };

  const handleCreateDownloadLink = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError('');
      const link = await api.createDownloadLink(document.id, downloadLimit);
      setDownloadLinks([link, ...downloadLinks]);
      setSuccess(`Lien créé avec ${link.limit} téléchargements`);
      setShowDownloadForm(false);
      setShowLinksList(true);
      setTimeout(() => setSuccess(''), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de création du lien');
    }
  };

  const handleLoadVersions = async () => {
    try {
      setError('');
      const result = await api.listVersions(document.id);
      setVersions(result.versions);
      setShowVersions(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement des versions');
    }
  };

  const handleCreateVersion = async () => {
    try {
      setError('');
      const version = await api.createVersion(document.id, versionLabel || undefined);
      setVersions([version, ...versions]);
      setSuccess('Version enregistrée !');
      setVersionLabel('');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur d\'enregistrement de version');
    }
  };

  const handleRestoreVersion = async (snapshotId: string) => {
    if (!confirm('Êtes-vous sûr de vouloir restaurer cette version ? Le contenu actuel sera remplacé.')) {
      return;
    }
    try {
      setError('');
      const restored = await api.restoreVersion(document.id, snapshotId);
      setDocument(restored);
      setContent(restored.content);
      setSuccess('Version restaurée !');
      setShowVersions(false);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de restauration');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setSuccess('Lien copié dans le presse-papier !');
    setTimeout(() => setSuccess(''), 2000);
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <button onClick={onBack}>← Retour</button>
          <h1>{document.title}</h1>
          {collaboration.isConnected && useRealtime && (
            <span className="badge badge-success">🟢 Temps réel</span>
          )}
        </div>
        <div className="navbar-actions">
          {quota && (
            <div className="navbar-info">
              <div style={{ fontSize: '0.75rem' }}>Quota restant</div>
              <div style={{ fontWeight: '600', color: quotaColor }}>
                {quota.remaining} / {quota.limit}
              </div>
            </div>
          )}
          <div className="navbar-info">
            <div>{writer?.name}</div>
          </div>
        </div>
      </nav>

      <div className="container" style={{ padding: '1rem', display: 'flex', gap: '1rem', height: 'calc(100vh - 4rem)' }}>
        {/* Sidebar présence */}
        <div className="card" style={{ width: '250px', padding: '1rem' }}>
          <h3 style={{ marginBottom: '1rem', fontSize: '1rem' }}>
            👥 Présents ({collaboration.connections.length + 1})
          </h3>
          <div style={{ fontSize: '0.875rem' }}>
            <div style={{ marginBottom: '0.5rem', fontWeight: '600' }}>
              {writer?.name} (vous)
            </div>
            {collaboration.connections.map((conn, i) => (
              <div key={i} style={{ marginBottom: '0.5rem', padding: '0.4rem', background: 'var(--surface-hover, rgba(255,255,255,0.05))', borderRadius: '4px' }}>
                <div style={{ fontWeight: '500' }}>🟢 {conn.writerName}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {conn.line ? `✍️ Ligne ${conn.line}, Col ${conn.col || 1}` : 'En ligne'}
                </div>
              </div>
            ))}
            {collaboration.connections.length === 0 && !collaboration.isConnected && (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.813rem' }}>
                Aucun autre collaborateur
              </div>
            )}
          </div>

          <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={useRealtime}
                onChange={(e) => setUseRealtime(e.target.checked)}
              />
              <span style={{ fontSize: '0.875rem' }}>Collaboration temps réel</span>
            </label>
            {!ticket && useRealtime && (
              <div style={{ fontSize: '0.75rem', color: 'var(--warning)', marginTop: '0.5rem' }}>
                Chargement...
              </div>
            )}
          </div>
        </div>

        {/* Éditeur principal */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {error && <div className="error">{error}</div>}
          {success && <div className="success">{success}</div>}

          <div className="editor-toolbar">
            <button 
              className="primary" 
              onClick={handleSave} 
              disabled={isSaving || content === document.content}
            >
              {isSaving ? 'Enregistrement...' : 'Enregistrer'}
            </button>
            
            {isOwner && (
              <>
                <button onClick={() => setShowShareForm(!showShareForm)}>
                  Partager
                </button>
                <button onClick={() => setShowDownloadForm(!showDownloadForm)}>
                  Créer un lien PDF
                </button>
                {downloadLinks.length > 0 && (
                  <button onClick={() => setShowLinksList(!showLinksList)}>
                    Mes liens ({downloadLinks.length})
                  </button>
                )}
              </>
            )}
            
            <button onClick={handleLoadVersions}>
              Historique
            </button>
            
            <button onClick={handleCreateVersion}>
              Enregistrer version
            </button>

            <div style={{ flex: 1 }}></div>
            
            <span className="text-muted">
              {content.length} caractères
            </span>
          </div>

          {showShareForm && (
            <form onSubmit={handleShare} className="card">
              <h3>Partager le document</h3>
              <div className="form-group">
                <label>ID du rédacteur</label>
                <input
                  type="text"
                  value={shareWriterId}
                  onChange={(e) => setShareWriterId(e.target.value)}
                  placeholder="writer_..."
                  required
                />
              </div>
              <div className="form-group">
                <label>Rôle</label>
                <select 
                  value={shareRole} 
                  onChange={(e) => setShareRole(e.target.value as 'editor' | 'viewer')}
                  style={{ padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
                >
                  <option value="editor">Éditeur (peut modifier)</option>
                  <option value="viewer">Lecteur (lecture seule)</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="submit" className="primary">Partager</button>
                <button type="button" onClick={() => setShowShareForm(false)}>Annuler</button>
              </div>
            </form>
          )}

          {showDownloadForm && (
            <form onSubmit={handleCreateDownloadLink} className="card">
              <h3>Créer un lien de téléchargement PDF</h3>
              <div className="form-group">
                <label>Nombre de téléchargements autorisés</label>
                <input
                  type="number"
                  value={downloadLimit}
                  onChange={(e) => setDownloadLimit(parseInt(e.target.value))}
                  min="1"
                  max="10000"
                  required
                />
              </div>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                Le lien donnera toujours la version actuelle du document au moment du téléchargement.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="submit" className="primary">Créer le lien</button>
                <button type="button" onClick={() => setShowDownloadForm(false)}>Annuler</button>
              </div>
            </form>
          )}

          {showLinksList && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3>Liens de téléchargement</h3>
                <button onClick={() => setShowLinksList(false)}>Fermer</button>
              </div>
              <div className="list">
                {downloadLinks.map((link) => (
                  <div key={link.id} className="list-item" style={{ cursor: 'default' }}>
                    <div className="list-item-title">
                      {link.used >= link.limit ? (
                        <span className="badge badge-danger">Épuisé</span>
                      ) : (
                        <span className="badge badge-success">Actif</span>
                      )}
                      {' '}{link.used} / {link.limit} téléchargements
                    </div>
                    <div className="list-item-meta" style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                      {link.url}
                    </div>
                    <button onClick={() => copyToClipboard(link.url)}>
                      📋 Copier le lien
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {showVersions && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3>Historique des versions</h3>
                <button onClick={() => setShowVersions(false)}>Fermer</button>
              </div>
              
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label>Libellé pour une nouvelle version (optionnel)</label>
                <input
                  type="text"
                  value={versionLabel}
                  onChange={(e) => setVersionLabel(e.target.value)}
                  placeholder="Ex: Version avant révision"
                />
              </div>

              {versions.length === 0 ? (
                <p className="text-muted">Aucune version enregistrée</p>
              ) : (
                <div className="list">
                  {versions.map((v) => (
                    <div key={v.snapshotId} className="list-item" style={{ cursor: 'default' }}>
                      <div className="list-item-title">
                        {v.label || `Version ${v.version}`}
                      </div>
                      <div className="list-item-meta">
                        {formatDate(v.createdAt)}
                      </div>
                      <button 
                        onClick={() => handleRestoreVersion(v.snapshotId)}
                        style={{ marginTop: '0.5rem' }}
                      >
                        Restaurer cette version
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {collaboration.connections.filter((c) => c.line).length > 0 && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', padding: '0.25rem 0' }}>
              {collaboration.connections
                .filter((c) => c.line)
                .map((conn, idx) => (
                  <span key={idx} className="badge badge-info" style={{ fontSize: '0.75rem' }}>
                    ✍️ {conn.writerName} : Ligne {conn.line}, Col {conn.col || 1}
                  </span>
                ))}
            </div>
          )}

          <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '1.5rem' }}>
            <textarea
              ref={textareaRef}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                background: 'transparent',
                color: 'var(--text)',
                fontFamily: '"Courier New", monospace',
                fontSize: '1rem',
                resize: 'none',
              }}
              value={content}
              onChange={(e) => {
                handleContentChange(e.target.value);
                handleCursorActivity();
              }}
              onKeyUp={handleCursorActivity}
              onClick={handleCursorActivity}
              onSelect={handleCursorActivity}
              placeholder="Commencez à écrire..."
              spellCheck={false}
            />
          </div>

          <div className="text-muted" style={{ fontSize: '0.875rem' }}>
            Document créé le {formatDate(document.createdAt)} • 
            Dernière modification : {formatDate(document.updatedAt)} •
            Version {document.version}
          </div>
        </div>
      </div>
    </div>
  );
}
