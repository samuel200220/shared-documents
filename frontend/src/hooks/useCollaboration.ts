import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import type { Connection } from '../types';

interface UseCollaborationProps {
  documentId: string;
  websocketUrl: string;
  ticket: string;
  initialContent?: string;
  onContentChange: (content: string) => void;
  onQuotaChange?: (quota: { used: number; limit: number; remaining: number; day: string }) => void;
  onError: (error: string) => void;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function useCollaboration({
  documentId,
  websocketUrl,
  ticket,
  initialContent = '',
  onContentChange,
  onQuotaChange,
  onError,
}: UseCollaborationProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const ydocRef = useRef<Y.Doc>(new Y.Doc());
  const ytextRef = useRef<Y.Text | null>(null);
  const epochRef = useRef<number>(1);
  const incomingChunksRef = useRef<Map<string, { parts: string[]; partCount: number; epoch: number }>>(new Map());

  // Helper pour envoyer un message JSON
  const sendMessage = useCallback((message: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  // Mettre à jour la position du curseur
  const updateCursor = useCallback((position: number, line = 1, col = 1) => {
    sendMessage({
      action: 'cursor',
      position,
      line,
      col,
    });
  }, [sendMessage]);

  useEffect(() => {
    if (!ticket || !websocketUrl) return;

    // Initialiser le document Yjs
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    const ytext = ydoc.getText('content');
    ytextRef.current = ytext;

    // Charger le contenu initial si disponible
    if (initialContent && ytext.length === 0) {
      ytext.insert(0, initialContent);
    }

    // Observer les changements pour l'UI
    const textObserver = () => {
      onContentChange(ytext.toString());
    };
    ytext.observe(textObserver);

    // Écouter les mises à jour locales de Yjs pour les envoyer au serveur
    const updateHandler = (update: Uint8Array, origin: any) => {
      if (origin !== 'server' && wsRef.current?.readyState === WebSocket.OPEN) {
        const updateBase64 = toBase64(update);
        const updateId = 'upd_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sendMessage({
          action: 'update',
          updateId,
          epoch: epochRef.current,
          update: updateBase64,
        });
      }
    };
    ydoc.on('update', updateHandler);

    // Ouvrir la connexion WebSocket
    const url = `${websocketUrl}?documentId=${encodeURIComponent(documentId)}&ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      // Envoyer le vecteur d'état initial pour synchronisation
      const stateVector = Y.encodeStateVector(ydoc);
      sendMessage({
        action: 'sync',
        stateVector: toBase64(stateVector),
        epoch: epochRef.current,
      });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'binary-part': {
            // Assemblage des fragments de message binaire
            const { transferId, partIndex, partCount, epoch, data: chunkData } = data;
            if (epoch !== undefined) epochRef.current = epoch;

            let transfer = incomingChunksRef.current.get(transferId);
            if (!transfer) {
              transfer = { parts: new Array(partCount), partCount, epoch };
              incomingChunksRef.current.set(transferId, transfer);
            }
            transfer.parts[partIndex] = chunkData;

            // Vérifier si toutes les parties sont arrivées
            const isComplete = transfer.parts.filter(Boolean).length === partCount;
            if (isComplete) {
              incomingChunksRef.current.delete(transferId);
              const fullBase64 = transfer.parts.join('');
              const updateBytes = fromBase64(fullBase64);
              if (updateBytes.byteLength > 0) {
                Y.applyUpdate(ydoc, updateBytes, 'server');
              }
            }
            break;
          }

          case 'presence': {
            if (Array.isArray(data.participants)) {
              setConnections((prev) => {
                const existingMap = new Map(prev.map((c) => [c.writerId, c]));
                return data.participants.map((p: { writerId: string; name: string }) => {
                  const existing = existingMap.get(p.writerId);
                  return {
                    writerId: p.writerId,
                    writerName: p.name,
                    position: existing?.position,
                    line: existing?.line,
                    col: existing?.col,
                  };
                });
              });
            }
            break;
          }

          case 'cursor': {
            // Mise à jour de la position d'un collaborateur
            setConnections((prev) =>
              prev.map((conn) =>
                conn.writerId === data.writerId
                  ? {
                      ...conn,
                      position: data.position,
                      line: data.line,
                      col: data.col,
                    }
                  : conn
              )
            );
            break;
          }

          case 'ack': {
            if (data.epoch !== undefined) {
              epochRef.current = data.epoch;
            }
            break;
          }

          case 'quota': {
            if (onQuotaChange) {
              onQuotaChange(data);
            }
            break;
          }

          case 'error': {
            onError(data.message || 'Erreur reçue du serveur.');
            break;
          }
        }
      } catch (err) {
        console.error('Erreur traitement message WebSocket:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('Erreur WebSocket:', error);
      onError('Erreur de connexion temps réel.');
      setIsConnected(false);
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    // Ping toutes les 25 secondes
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        sendMessage({ action: 'ping' });
      }
    }, 25000);

    return () => {
      clearInterval(pingInterval);
      ydoc.off('update', updateHandler);
      ytext.unobserve(textObserver);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [documentId, websocketUrl, ticket, initialContent, onContentChange, onQuotaChange, onError, sendMessage]);

  // Remplacement ou insertion de texte local
  const updateContent = (newContent: string) => {
    const ytext = ytextRef.current;
    const ydoc = ydocRef.current;
    if (!ytext || !ydoc) return;

    const currentContent = ytext.toString();
    if (currentContent !== newContent) {
      ydoc.transact(() => {
        ytext.delete(0, currentContent.length);
        ytext.insert(0, newContent);
      }, 'local');
    }
  };

  return {
    isConnected,
    connections,
    updateContent,
    updateCursor,
  };
}
