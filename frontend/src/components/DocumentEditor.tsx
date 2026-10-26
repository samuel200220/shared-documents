import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import type { Document, DownloadLink, DocumentVersion, Quota } from '../types';

interface DocumentEditorProps {
  document: Document;
  onBack: () => void;
}

export function DocumentEditor({ document: initialDoc, onBack }: DocumentEditorProps) {
  const [document, setDocument] = useState(initialDoc);
  const [content, setContent] = useState(initialDoc.content);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  
  // État pour les fonctionnalités
  const [showShareForm, setShowShareForm] = useState(false);
  const [showDownloadForm, setShowDownloadForm] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [downloadLinks, setDownloadLinks] = useState<DownloadLink[]>([]);
  
  const [shareWriterId, setShareWriterId] = useState('');
  const [shareRole, setShareRole] = useState<'editor' | 'viewer'>('editor');
  const [downloadLimit, setDownloadLimit] = useState(500);
  const [versionLabel, setVersionLabel] = useState('');

  const writer = api.getWriter();
  const isOwner = document.ownerId === writer?.id;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadQuota();
  }, []);

  const loadQuota = async () => {
    try {
      const q = await api.getQuota();
      setQuota(q);
    } catch (err) {
      console.error('Erreur quota:', err);
    }
  };

  const handleSave = async () => {
    if (content === document.content) {
      setSuccess('Aucune modification à enregistrer');
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
      setSuccess(`Lien créé : ${link.url}`);
      setShowDownloadForm(false);
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

      <div className="container editor-container">
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

        <div className="editor-content">
          <textarea
            ref={textareaRef}
            className="editor-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
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
  );
}
