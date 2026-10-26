import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

type DownloadState = 'idle' | 'checking' | 'available' | 'waiting' | 'downloading' | 'exhausted' | 'success' | 'error';

export function PublicDownload() {
  const [secret, setSecret] = useState('');
  const [state, setState] = useState<DownloadState>('idle');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number>(0);
  const countdownIntervalRef = useRef<any>(null);

  // Extraire le secret depuis l'URL (query param ou path)
  const extractSecret = (): string => {
    const urlParams = new URLSearchParams(window.location.search);
    const querySecret = urlParams.get('secret') || urlParams.get('download') || urlParams.get('token');
    if (querySecret) return querySecret.trim();

    const path = window.location.pathname;
    const match = path.match(/^\/(?:download|downloads)\/([^/?#]+)/);
    if (match) return match[1].trim();

    return '';
  };

  const initialSecret = extractSecret();

  // Vérifier le statut du lien (sans consommer d'exemplaire)
  const checkStatus = async (token: string, silent = false) => {
    if (!token) return;
    try {
      if (!silent) setState('checking');
      const info = await api.checkDownloadStatus(token);
      if (info.status === 'exhausted' || info.remaining === 0) {
        setState('exhausted');
        setRemaining(0);
        setTotal(info.maxDownloads);
        setError("Ce lien de téléchargement est épuisé. L'ensemble des exemplaires autorisés ont été distribués.");
      } else {
        setState('available');
        setRemaining(info.remaining);
        setTotal(info.maxDownloads);
        setError('');
      }
    } catch (err: any) {
      if (err.message?.includes('410') || err.message?.includes('atteinte') || err.message?.includes('épuisé')) {
        setState('exhausted');
        setRemaining(0);
        setError("Ce lien de téléchargement a atteint sa limite maximale d'exemplaires.");
      } else if (err.message?.includes('404')) {
        setState('error');
        setError("Ce lien de téléchargement n'existe pas ou est invalide.");
      } else if (!silent) {
        setState('available');
      }
    }
  };

  const triggerDownload = async (downloadSecret: string, attempt = 1) => {
    if (!downloadSecret) return;

    try {
      setState('downloading');
      setError('');
      setSuccess('');

      const result = await api.downloadDocument(downloadSecret);

      // Créer et déclencher le téléchargement du PDF
      const url = window.URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `journal-edition-${Date.now().toString().slice(-4)}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      setState('success');
      if (result.remaining !== undefined) {
        setRemaining(result.remaining);
      }
      setSuccess('Votre exemplaire PDF a été généré et téléchargé avec succès !');
    } catch (err: any) {
      const status = err.status;
      const message = err.message || '';

      if (status === 410 || message.includes('410') || message.includes('limite') || message.includes('épuisé')) {
        setState('exhausted');
        setRemaining(0);
        setError("La limite autorisée d'exemplaires a été atteinte au moment de votre demande. Le lien est épuisé.");
      } else if (status === 429 || status === 503 || message.includes('503') || message.includes('BUSY') || message.includes('occupée')) {
        // Forte affluence (Contrainte 5) : mise en file d'attente avec compte à rebours
        setState('waiting');
        const waitTime = err.retryAfter || (attempt <= 3 ? 2 : 4);
        setRetryCountdown(waitTime);
        setError(`Forte affluence sur le service : votre place est réservée. Nouvelle tentative automatique dans ${waitTime}s...`);

        if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
        let left = waitTime;
        countdownIntervalRef.current = setInterval(() => {
          left -= 1;
          setRetryCountdown(left);
          if (left <= 0) {
            clearInterval(countdownIntervalRef.current);
            triggerDownload(downloadSecret, attempt + 1);
          }
        }, 1000);
      } else if (status === 404 || message.includes('404')) {
        setState('error');
        setError("Ce lien de téléchargement n'existe pas ou a été révoqué.");
      } else {
        setState('error');
        setError(message || 'Une erreur est survenue lors de la génération du téléchargement.');
      }
    }
  };

  useEffect(() => {
    if (initialSecret) {
      setSecret(initialSecret);
      checkStatus(initialSecret);
    }
    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, []);

  // Polling silencieux de l'état du lien toutes les 5 secondes (Contrainte 6)
  useEffect(() => {
    if (!secret || state === 'exhausted' || state === 'downloading' || state === 'waiting') return;

    const interval = setInterval(() => {
      checkStatus(secret, true);
    }, 5000);

    return () => clearInterval(interval);
  }, [secret, state]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret.trim()) return;
    triggerDownload(secret.trim());
  };

  return (
    <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '1rem' }}>
      <div className="card" style={{ maxWidth: '620px', width: '100%', padding: '2rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>📰</div>
          <h1 style={{ fontSize: '1.75rem', marginBottom: '0.5rem' }}>
            Journal Numérique de l'Association
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
            Distribution officielle de l'édition mise à jour en temps réel
          </p>
        </div>

        {/* Badges d'état du lien */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.5rem' }}>
          {state === 'checking' && (
            <span className="badge badge-info">Vérification de la disponibilité...</span>
          )}
          {state === 'available' && remaining !== null && (
            <span className="badge badge-success">
              🟢 Exemplaires disponibles : {remaining} {total ? `/ ${total}` : ''}
            </span>
          )}
          {state === 'waiting' && (
            <span className="badge badge-warning">
              ⏳ Affluence élevée : file d'attente active ({retryCountdown}s)
            </span>
          )}
          {state === 'exhausted' && (
            <span className="badge badge-danger">
              🔴 Lien épuisé : 0 exemplaire restant
            </span>
          )}
        </div>

        {/* Message d'erreur ou d'épuisement */}
        {error && (
          <div className="error" style={{ marginBottom: '1.25rem', padding: '1rem', borderRadius: '8px' }}>
            {error}
          </div>
        )}

        {/* Message de succès */}
        {success && (
          <div className="success" style={{ marginBottom: '1.25rem', padding: '1rem', borderRadius: '8px' }}>
            {success}
          </div>
        )}

        {/* Formulaire ou bouton d'action */}
        {state !== 'exhausted' && (
          <div style={{ marginBottom: '1.5rem' }}>
            {initialSecret ? (
              <button
                type="button"
                className="primary"
                onClick={() => triggerDownload(secret)}
                disabled={state === 'downloading' || state === 'waiting' || state === 'checking'}
                style={{ width: '100%', padding: '0.875rem', fontSize: '1.05rem', fontWeight: '600' }}
              >
                {state === 'downloading'
                  ? 'Génération de votre exemplaire PDF...'
                  : state === 'waiting'
                  ? `Patientez dans la file (${retryCountdown}s)...`
                  : '📥 Télécharger mon exemplaire PDF'}
              </button>
            ) : (
              <form onSubmit={handleSubmit} className="form">
                <div className="form-group">
                  <label htmlFor="secret">Code secret du lien</label>
                  <input
                    id="secret"
                    type="text"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="Collez ici le jeton ou code secret de téléchargement"
                    required
                    disabled={state === 'downloading' || state === 'waiting'}
                  />
                </div>
                <button
                  type="submit"
                  className="primary"
                  disabled={state === 'downloading' || state === 'waiting' || !secret.trim()}
                  style={{ width: '100%', padding: '0.875rem', fontSize: '1.05rem', fontWeight: '600' }}
                >
                  {state === 'downloading' ? 'Génération du PDF...' : '📥 Télécharger le PDF'}
                </button>
              </form>
            )}
          </div>
        )}

        {/* Bloc d'informations et garanties du cahier des charges */}
        <div style={{ padding: '1.25rem', background: 'var(--surface-hover, rgba(255,255,255,0.03))', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <h3 style={{ fontSize: '0.95rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            ℹ️ Garanties de distribution
          </h3>
          <ul style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0, paddingLeft: '1.25rem', lineHeight: '1.5' }}>
            <li>Le fichier distribué est un PDF conforme à la dernière version corrigée par la rédaction.</li>
            <li>Aucune inscription ni authentification requise pour les visiteurs.</li>
            <li>Gestion stricte du quota d'exemplaires avec réservation atomique instantanée.</li>
            <li>En cas de pic de trafic, le système ordonnance les requêtes sans interruption.</li>
          </ul>
        </div>

        <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
          <a href="/" style={{ color: 'var(--primary)', textDecoration: 'none', fontSize: '0.875rem' }}>
            ← Retour à l'espace rédacteurs
          </a>
        </div>
      </div>
    </div>
  );
}
