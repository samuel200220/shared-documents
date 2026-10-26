import { useState, useEffect } from 'react';

interface AdminStats {
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

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adminSecret, setAdminSecret] = useState('');
  const [authenticated, setAuthenticated] = useState(false);

  const loadStats = async (secret: string) => {
    try {
      setLoading(true);
      setError('');
      const response = await fetch(`${API_BASE_URL}/admin/stats`, {
        headers: {
          'Authorization': `Bearer ${secret}`,
        },
      });

      if (!response.ok) {
        throw new Error('Erreur d\'authentification ou de chargement');
      }

      const data = await response.json();
      setStats(data);
      setAuthenticated(true);
      // Stocker le secret dans sessionStorage
      sessionStorage.setItem('admin_secret', secret);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Vérifier si un secret est déjà stocké
    const stored = sessionStorage.getItem('admin_secret');
    if (stored) {
      loadStats(stored);
    } else {
      setLoading(false);
    }
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminSecret) return;
    loadStats(adminSecret);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('admin_secret');
    setAuthenticated(false);
    setStats(null);
    setAdminSecret('');
  };

  const handleRefresh = () => {
    const secret = sessionStorage.getItem('admin_secret');
    if (secret) {
      loadStats(secret);
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

  const formatTimeRemaining = (until: number) => {
    const remaining = Math.max(0, until - Date.now());
    const minutes = Math.floor(remaining / 60000);
    if (minutes < 1) return 'Expire bientôt';
    if (minutes < 60) return `${minutes} min restantes`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}min`;
  };

  // Écran de connexion admin
  if (!authenticated) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="card" style={{ maxWidth: '500px', width: '100%' }}>
          <h1 style={{ marginBottom: '1rem' }}>🔐 Administration</h1>
          <p style={{ marginBottom: '1.5rem', color: 'var(--text-muted)' }}>
            Accès réservé aux administrateurs
          </p>

          {error && (
            <div className="error" style={{ marginBottom: '1rem' }}>
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} className="form">
            <div className="form-group">
              <label htmlFor="secret">Secret administrateur</label>
              <input
                id="secret"
                type="password"
                value={adminSecret}
                onChange={(e) => setAdminSecret(e.target.value)}
                placeholder="Entrez le secret admin"
                required
                disabled={loading}
              />
            </div>

            <button type="submit" className="primary" disabled={loading}>
              {loading ? 'Connexion...' : 'Se connecter'}
            </button>

            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '1rem' }}>
              Note : En développement, le secret par défaut est "changeme".
              En production, configurez la variable d'environnement ADMIN_SECRET.
            </p>
          </form>

          <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
            <a href="/" style={{ color: 'var(--primary)', textDecoration: 'none' }}>
              ← Retour à l'application
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Dashboard admin
  return (
    <div className="page">
      <nav className="navbar">
        <h1>🔐 Tableau de bord administrateur</h1>
        <div className="navbar-actions">
          <button onClick={handleRefresh} disabled={loading}>
            {loading ? 'Chargement...' : '🔄 Actualiser'}
          </button>
          <button onClick={handleLogout}>Déconnexion</button>
        </div>
      </nav>

      <div className="container" style={{ paddingTop: '2rem' }}>
        {error && (
          <div className="error" style={{ marginBottom: '1rem' }}>
            {error}
          </div>
        )}

        {loading ? (
          <div className="loading">
            <div className="spinner"></div>
          </div>
        ) : stats ? (
          <div className="grid gap-3">
            {/* Documents ouverts */}
            <div className="card">
              <h2 style={{ marginBottom: '1rem' }}>📄 Documents ouverts ({stats.openDocuments.length})</h2>
              {stats.openDocuments.length === 0 ? (
                <p className="text-muted">Aucun document</p>
              ) : (
                <div className="list">
                  {stats.openDocuments.map((doc) => (
                    <div key={doc.id} className="list-item" style={{ cursor: 'default' }}>
                      <div className="list-item-title">{doc.title}</div>
                      <div className="list-item-meta">
                        ID: {doc.id} • Propriétaire: {doc.ownerId}<br />
                        Version {doc.version} • Modifié: {formatDate(doc.updatedAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Liens de téléchargement actifs */}
            <div className="card">
              <h2 style={{ marginBottom: '1rem' }}>🔗 Liens de téléchargement ({stats.activeLinks.length})</h2>
              {stats.activeLinks.length === 0 ? (
                <p className="text-muted">Aucun lien</p>
              ) : (
                <div className="list">
                  {stats.activeLinks.map((link) => (
                    <div key={link.id} className="list-item" style={{ cursor: 'default' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <div className="list-item-title">
                          {link.status === 'active' ? (
                            <span className="badge badge-success">Actif</span>
                          ) : (
                            <span className="badge badge-danger">Épuisé</span>
                          )}
                          {' '}Document: {link.documentId.slice(0, 12)}...
                        </div>
                        <div style={{ fontWeight: '600', color: link.status === 'active' ? 'var(--success)' : 'var(--danger)' }}>
                          {link.used} / {link.limit}
                        </div>
                      </div>
                      <div className="list-item-meta">
                        Restants: {link.remaining} • Créé le {formatDate(link.createdAt)}
                        <br />
                        Créateur: {link.creatorId}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Utilisateurs bloqués */}
            <div className="card">
              <h2 style={{ marginBottom: '1rem' }}>🚫 Utilisateurs bloqués ({stats.blockedWriters.length})</h2>
              {stats.blockedWriters.length === 0 ? (
                <p className="text-muted">Aucun blocage actif</p>
              ) : (
                <div className="list">
                  {stats.blockedWriters.map((blocked) => (
                    <div key={blocked.writerId} className="list-item" style={{ cursor: 'default' }}>
                      <div className="list-item-title">
                        <span className="badge badge-warning">Bloqué</span>
                        {' '}{blocked.writerId}
                      </div>
                      <div className="list-item-meta">
                        {blocked.reason}<br />
                        Expire dans: {formatTimeRemaining(blocked.blockedUntil)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Connexions actives */}
            <div className="card">
              <h2 style={{ marginBottom: '1rem' }}>🟢 Connexions actives ({stats.activeConnections.length})</h2>
              {stats.activeConnections.length === 0 ? (
                <p className="text-muted">Aucune connexion active</p>
              ) : (
                <div className="list">
                  {stats.activeConnections.map((conn) => (
                    <div key={conn.connectionId} className="list-item" style={{ cursor: 'default' }}>
                      <div className="list-item-title">
                        {conn.writerName}
                      </div>
                      <div className="list-item-meta">
                        Document: {conn.documentId}<br />
                        Connecté depuis: {formatDate(conn.connectedAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: '2rem', textAlign: 'center' }}>
          <a href="/" style={{ color: 'var(--primary)', textDecoration: 'none' }}>
            ← Retour à l'application
          </a>
        </div>
      </div>
    </div>
  );
}
