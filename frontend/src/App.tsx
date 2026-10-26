import { useState, useEffect } from 'react';
import { api } from './api';
import { Login } from './components/Login';
import { DocumentList } from './components/DocumentList';
import { CollaborativeEditor } from './components/CollaborativeEditor';
import { PublicDownload } from './components/PublicDownload';
import { AdminDashboard } from './components/AdminDashboard';
import type { Document } from './types';

type View = 'login' | 'list' | 'editor' | 'loading-doc' | 'download' | 'admin';

function App() {
  const [view, setView] = useState<View>('login');
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    // Check if this is a public download route
    if (
      window.location.pathname.startsWith('/download') ||
      window.location.pathname.startsWith('/downloads') ||
      window.location.search.includes('secret=') ||
      window.location.search.includes('download=') ||
      window.location.search.includes('token=')
    ) {
      setView('download');
      return;
    }

    // Check if this is the admin route
    if (window.location.pathname === '/admin') {
      setView('admin');
      return;
    }

    // Check if user is already authenticated
    if (api.isAuthenticated()) {
      setView('list');
    } else {
      setView('login');
    }
  }, []);

  const handleLogin = () => {
    setView('list');
  };

  const handleSelectDocument = async (doc: Document) => {
    // Show loading state while fetching full document
    setView('loading-doc');
    setLoadError('');
    try {
      const fullDoc = await api.getDocument(doc.id);
      // The API returns { document, role }, extract the document
      const resolvedDoc: Document = {
        id: fullDoc.id || doc.id,
        ownerId: fullDoc.ownerId || doc.ownerId,
        title: fullDoc.title || doc.title,
        content: fullDoc.content ?? '',
        createdAt: fullDoc.createdAt || doc.createdAt,
        updatedAt: fullDoc.updatedAt || doc.updatedAt,
        version: fullDoc.version || doc.version,
        epoch: fullDoc.epoch || 0,
      };
      setSelectedDocument(resolvedDoc);
      setView('editor');
    } catch (err) {
      console.error('Error loading document:', err);
      setLoadError(err instanceof Error ? err.message : 'Impossible de charger le document');
      setView('list');
    }
  };

  const handleBackToList = () => {
    setSelectedDocument(null);
    setView('list');
  };

  // Public download route
  if (view === 'download') {
    return <PublicDownload />;
  }

  // Admin route
  if (view === 'admin') {
    return <AdminDashboard />;
  }

  // Login
  if (view === 'login') {
    return <Login onLogin={handleLogin} />;
  }

  // Loading document
  if (view === 'loading-doc') {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="loading">
          <div className="spinner"></div>
          <span>Chargement du document…</span>
        </div>
      </div>
    );
  }

  // Document list
  if (view === 'list') {
    return <DocumentList onSelectDocument={handleSelectDocument} loadError={loadError} />;
  }

  // Editor with loaded document
  if (view === 'editor' && selectedDocument) {
    return <CollaborativeEditor document={selectedDocument} onBack={handleBackToList} />;
  }

  return null;
}

export default App;
