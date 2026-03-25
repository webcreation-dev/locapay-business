import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import { QRCodeCanvas } from 'qrcode.react';

// ─── UTILITAIRES ──────────────────────────────────────────────────────────────
const getInitials = (name) => {
  if (!name || name === 'Inconnu') return '?';
  return name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
};

const getRandomColor = (name = '') => {
  const colors = ['#00a884', '#007bff', '#6610f2', '#6f42c1', '#e83e8c', '#dc3545', '#fd7e14', '#ffc107', '#28a745', '#20c997', '#17a2b8'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
};

const formatTime = (timestamp) => {
  const date = new Date(parseInt(timestamp) * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
};

const getDateLabel = (timestamp) => {
  const date = new Date(parseInt(timestamp) * 1000);
  const now = new Date();
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  const msgDate = new Date(date);
  msgDate.setHours(0, 0, 0, 0);

  if (msgDate.getTime() === today.getTime()) return "AUJOURD'HUI";
  if (msgDate.getTime() === yesterday.getTime()) return "HIER";
  
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  if (msgDate.getTime() > sevenDaysAgo.getTime()) {
    return date.toLocaleDateString('fr-FR', { weekday: 'long' }).toUpperCase();
  }
  
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
};

const PAGE_SIZE = 30; // Messages chargés par page

// ─── TRADUCTION DES CHAMPS MANQUANTS ─────────────────────────────────────────
const translateFieldName = (field) => ({
  'rent_price': 'Prix du loyer',
  'type': 'Type de bien',
  'localisation': 'Localisation',
  'number_rooms': 'Nombre de chambres',
  'number_living_rooms': 'Nombre de salons',
  'description': 'Description',
  'location': 'Localisation',
  'price': 'Prix',
  'rooms': 'Chambres'
}[field] || field);


// ─── COMPOSANT BULLE (MÉMOÏSÉ STRICTEMENT) ────────────────────────────────────
const MessageBubble = memo(({ msg, isFirstInGroup, dateStr, isSelected, onSelect }) => {
  // Conversion robuste de is_from_me en vrai booléen
  const isFromMe = msg.is_from_me === true || msg.is_from_me === 1 || msg.is_from_me === "true";
  const isNoise = msg.property_group_id === 'noise';
  const isGrouped = msg.property_group_id && !isNoise;
  const mediaUrl = msg.media_path ? '/' + msg.media_path.replace('./', '') : null;

  const bubbleClass = `message ${isFromMe ? 'out' : 'in'} ${isFirstInGroup ? 'first' : ''} ${isNoise ? 'noise' : ''} ${isGrouped ? 'grouped' : ''}`.trim();

  return (
    <div className={`message-group ${isFirstInGroup ? 'first' : ''}`}>
      <div
        className="message-checkbox-container"
        style={{
          justifyContent: isFromMe ? 'flex-end' : 'flex-start',
          width: '100%'
        }}
      >
        {/* Checkbox masquée si message déjà groupé (bien détecté/créé) */}
        {!isFromMe && !isGrouped && (
          <input type="checkbox" className="msg-checkbox" checked={isSelected} onChange={() => onSelect(msg.id)} />
        )}
        <div className={bubbleClass} style={{ width: 'fit-content', maxWidth: '320px' }}>
          {!isFromMe && isFirstInGroup && (
            <div className="sender-name" style={{ color: getRandomColor(msg.sender_name || 'Inconnu') }}>
              {msg.sender_name || 'Inconnu'}
            </div>
          )}
          <div className="message-content">
            {msg.has_media && mediaUrl && (
              <div className="media-container" style={{ minHeight: msg.media_mime_type?.startsWith('image/') ? '120px' : 'auto' }}>
                {msg.media_mime_type?.startsWith('image/') && <img src={mediaUrl} className="media-item large" loading="eager" alt="" />}
                {msg.media_mime_type?.startsWith('video/') && <video src={mediaUrl} controls className="media-item large" />}
                {msg.media_mime_type?.startsWith('audio/') && <audio src={mediaUrl} controls style={{ width: '200px', height: '35px' }} />}
              </div>
            )}
            {msg.body && <div style={{ fontSize: '14.2px', whiteSpace: 'pre-wrap' }}>{msg.body}</div>}
          </div>
          <div className="message-footer">
            <span className="timestamp">{dateStr}</span>
          </div>
        </div>
      </div>
    </div>
  );
}, (prev, next) =>
  prev.isSelected === next.isSelected &&
  prev.msg.property_group_id === next.msg.property_group_id &&
  prev.msg.body === next.msg.body
);

// ─── APP PRINCIPALE ───────────────────────────────────────────────────────────
function App() {
  const [chats, setChats] = useState([]);
  const [currentChatId, setCurrentChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [botStatus, setBotStatus] = useState('LOADING');
  const [qrCode, setQrCode] = useState(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [toast, setToast] = useState(null); // { message: string, type: 'error'|'success' }
  const [activeSubmissions, setActiveSubmissions] = useState({}); // { [pendingGroupId]: { status, progress, errors, successData } }
  const [isGroupSelection, setIsGroupSelection] = useState(false);
  const [lastSelectedId, setLastSelectedId] = useState(null);

  const containerRef = useRef(null);       // ref vers la div messages-container
  const scrollPositionBeforeSubmit = useRef(null); // Position scroll avant soumission
  const isManualActionRef = useRef(false);       // verrou : bloque le scroll auto après action manuelle
  const isInitialLoadingRef = useRef(false);      // verrou : bloque loadOlderMessages pendant le chargement initial
  const scrollMemory = useRef({});          // mémoire de scroll par chatId  { chatId: scrollTop }
  const lastNewMsgCount = useRef(0);           // nombre de messages la dernière fois
  const currentChatIdRef = useRef(null);        // valeur synchrone du chatId courant
  const pollingLockRef = useRef(false);       // évite les requêtes en double
  const shownErrorIdsRef = useRef(new Set());   // IDs des messages dont l'erreur a déjà été affichée

  // ─── POLLING CHATS ──────────────────────────────────────────────────────────
  const fetchChats = useCallback(async () => {
    try {
      const response = await fetch('/api/chats');
      const data = await response.json();
      setChats(data);
    } catch (e) {
      console.error('fetchChats error', e);
    }
  }, []);

  useEffect(() => {
    fetchChats();
    const id = setInterval(fetchChats, 4000);
    return () => clearInterval(id);
  }, [fetchChats]);

  // ─── POLLING STATUS / QR ─────────────────────────────────────────────────────
  useEffect(() => {
    const fetch_ = async () => {
      try {
        const { status } = await (await fetch('/api/status')).json();
        setBotStatus(status);
        if (status === 'QR') { const { qr } = await (await fetch('/api/qr')).json(); setQrCode(qr); }
        else setQrCode(null);
      } catch (e) { console.error('status', e); }
    };
    fetch_();
    const id = setInterval(fetch_, 3000);
    return () => clearInterval(id);
  }, []);

  // ─── EFFACER TOAST APRÈS 8s ────────────────────────────────────────────────
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(null), 8000);
      return () => clearTimeout(id);
    }
  }, [toast]);

  // ─── POLLING MESSAGES (NOUVEAUX SEULEMENT) ───────────────────────────────────
  useEffect(() => {
    if (!currentChatId) return;
    currentChatIdRef.current = currentChatId;

    // Chargement initial
    const loadInitial = async () => {
      try {
        // 🔒 Activer le verrou : empêche loadOlderMessages de se déclencher pendant le chargement
        isInitialLoadingRef.current = true;

        const data = await (await fetch(`/api/messages/${currentChatId}?limit=${PAGE_SIZE}`)).json();
        setMessages(data);
        setHasMore(data.length === PAGE_SIZE);
        lastNewMsgCount.current = data.length;

        // Après render, scroll en bas ou restaure la position
        setTimeout(() => {
          const el = containerRef.current;
          if (!el) return;
          if (scrollMemory.current[currentChatId] != null) {
            el.scrollTop = scrollMemory.current[currentChatId];
          } else {
            el.scrollTop = el.scrollHeight;
          }
          // 🔓 Désactiver le verrou après que le scroll est restauré
          setTimeout(() => { isInitialLoadingRef.current = false; }, 500);
        }, 80);
      } catch (e) { console.error('init messages', e); isInitialLoadingRef.current = false; }
    };
    loadInitial();

    // Polling léger : uniquement les NOUVEAUX messages (timestamp > dernier)
    const poll = setInterval(async () => {
      if (pollingLockRef.current) return;
      if (isManualActionRef.current) return; // Ne pas poll pendant une soumission
      pollingLockRef.current = true;
      try {
        const chatId = currentChatIdRef.current;
        if (!chatId) return;
        const data = await (await fetch(`/api/messages/${chatId}?limit=${PAGE_SIZE}`)).json();
        setMessages(prev => {
          // 1. Détection d'erreurs NestJS pour le toast (une seule fois par message)
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
          const errorMessage = data.find(m =>
            m.analysis_error &&
            !shownErrorIdsRef.current.has(m.id) &&
            m.timestamp * 1000 > fiveMinutesAgo
          );
          if (errorMessage) {
            shownErrorIdsRef.current.add(errorMessage.id);
            setToast({ message: `❌ Échec Création : ${errorMessage.analysis_error}`, type: 'error' });
          }

          // 2. FUSION INTELLIGENTE (Fix : Ne pas perdre les messages chargés en scrollant)
          // On crée une map des nouveaux messages par ID
          const dataMap = new Map(data.map(m => [m.id, m]));

          // On met à jour les messages existants et on ajoute les nouveaux
          const updatedPrev = prev.map(p => {
            const fresh = dataMap.get(p.id);
            if (!fresh) return p;

            // FIX: Respecter l'état "pending" local. 
            // Si le message est en attente (bleu) et que le backend dit encore "null", on garde "pending".
            const isCurrentlyPending = p.property_group_id?.startsWith('pending_');
            const isFreshProcessed = fresh.real_property_id || fresh.property_group_id?.startsWith('real_prop_') || fresh.analysis_error;

            if (isCurrentlyPending && !isFreshProcessed) {
              return p; 
            }

            // On ne met à jour que si les champs importants ont changé (IA, bien créé, etc)
            if (p.property_group_id !== fresh.property_group_id || p.real_property_id !== fresh.real_property_id || p.analysis_error !== fresh.analysis_error) {
              return { ...p, ...fresh };
            }
            return p;
          });

          // Trouver les messages dans 'data' qui ne sont pas encore dans 'updatedPrev'
          const existingIds = new Set(updatedPrev.map(p => p.id));
          const newOnly = data.filter(d => !existingIds.has(d.id));

          // Si rien n'a changé du tout, retourner prev (évite les re-renders inutiles)
          if (newOnly.length === 0 && updatedPrev.every((msg, i) => msg === prev[i])) {
            return prev;
          }

          return [...updatedPrev, ...newOnly].sort((a, b) => a.timestamp - b.timestamp);
        });
      } catch (e) { console.error('poll messages', e); }
      finally { pollingLockRef.current = false; }
    }, 2500);

    return () => { clearInterval(poll); currentChatIdRef.current = null; };
  }, [currentChatId]);

  // ─── SCROLL AUTO UNIQUEMENT SI DÉJÀ EN BAS ET NOUVEAU MSG ───────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (isManualActionRef.current) return; // verrou action manuelle → rien

    const currentCount = messages.length;
    const previousCount = lastNewMsgCount.current;
    const hasNewMessages = currentCount > previousCount;
    lastNewMsgCount.current = currentCount;

    if (!hasNewMessages) return; // Pas de nouveaux messages → on ne bouge PAS

    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
    if (isAtBottom) {
      // L'utilisateur est déjà tout en bas → on suit le nouveau message
      el.scrollTop = el.scrollHeight;
    } else {
      // L'utilisateur est en train de lire → on affiche le bouton "Nouveau"
      setShowScrollToBottom(true);
    }
  }, [messages]);

  // ─── CHARGEMENT DES MESSAGES PLUS ANCIENS (SCROLL VERS LE HAUT) ─────────────
  const loadOlderMessages = useCallback(async () => {
    // 🔒 Bloqué pendant le chargement initial (sinon scrollTop=0 le déclenche par erreur)
    if (isInitialLoadingRef.current) return;
    if (isLoadingMore || !hasMore || messages.length === 0) return;
    setIsLoadingMore(true);

    const el = containerRef.current;
    const oldScrollHeight = el.scrollHeight;
    const oldScrollTop = el.scrollTop;
    const oldestTimestamp = messages[0].timestamp;

    try {
      const older = await (await fetch(`/api/messages/${currentChatId}?limit=${PAGE_SIZE}&before=${oldestTimestamp}`)).json();
      if (older.length === 0) { setHasMore(false); return; }

      setMessages(prev => [...older, ...prev]);
      setHasMore(older.length === PAGE_SIZE);

      // Restauration précise du scroll après ajout des anciens messages
      requestAnimationFrame(() => {
        if (containerRef.current) {
          const gained = containerRef.current.scrollHeight - oldScrollHeight;
          containerRef.current.scrollTop = oldScrollTop + gained;
        }
      });
    } catch (e) { console.error('load older', e); }
    finally { setIsLoadingMore(false); }
  }, [currentChatId, messages, isLoadingMore, hasMore]);

  // ─── GESTION DU SCROLL (MÉMOIRE + CHARGE + BOUTON) ─────────────────────────
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    // Mémoriser la position pour ce chat
    if (currentChatIdRef.current) {
      scrollMemory.current[currentChatIdRef.current] = el.scrollTop;
    }

    // Masquer le bouton si on est en bas
    if (el.scrollHeight - el.scrollTop <= el.clientHeight + 60) {
      setShowScrollToBottom(false);
    }

    // Charger des messages plus anciens si on remonte en haut
    if (el.scrollTop < 80) {
      loadOlderMessages();
    }
  }, [loadOlderMessages]);

  // ─── SÉLECTION DE CHAT ───────────────────────────────────────────────────────
  const handleSelectChat = useCallback((id) => {
    // Sauvegarder la position actuelle avant de quitter
    if (currentChatIdRef.current && containerRef.current) {
      scrollMemory.current[currentChatIdRef.current] = containerRef.current.scrollTop;
    }
    setCurrentChatId(id);
    setSelectedMessageIds([]);
    setMessages([]);
    setShowScrollToBottom(false);
    setHasMore(true);
    lastNewMsgCount.current = 0;
  }, []);

  // ─── SÉLECTION DE MESSAGE ─────────────────────────────────────────────────────
  const toggleMessageSelection = useCallback((id) => {
    setSelectedMessageIds(prev => {
      const isCurrentlySelected = prev.includes(id);

      // Si le mode sélection groupée est actif et qu'on a un point de départ
      if (!isCurrentlySelected && isGroupSelection && lastSelectedId) {
        const startIdx = messages.findIndex(m => m.id === lastSelectedId);
        const endIdx = messages.findIndex(m => m.id === id);

        if (startIdx !== -1 && endIdx !== -1) {
          const range = messages.slice(
            Math.min(startIdx, endIdx),
            Math.max(startIdx, endIdx) + 1
          );

          // On ne sélectionne que les messages éligibles
          const eligibleIds = range
            .filter(m => {
              const isFromMe = m.is_from_me === true || m.is_from_me === 1 || m.is_from_me === "true";
              const isNoise = m.property_group_id === 'noise';
              const isGrouped = m.property_group_id && !isNoise;
              return !isFromMe && !isGrouped;
            })
            .map(m => m.id);

          setLastSelectedId(id);
          return [...new Set([...prev, ...eligibleIds])];
        }
      }

      // Comportement normal (toggle unique)
      setLastSelectedId(isCurrentlySelected ? null : id);
      return isCurrentlySelected ? prev.filter(x => x !== id) : [...prev, id];
    });
  }, [isGroupSelection, lastSelectedId, messages]);

  const toggleMultipleSelection = useCallback((ids) => {
    setSelectedMessageIds(prev => {
      const allIncluded = ids.every(id => prev.includes(id));
      if (allIncluded) {
        return prev.filter(x => !ids.includes(x));
      } else {
        const toAdd = ids.filter(x => !prev.includes(x));
        return [...prev, ...toAdd];
      }
    });
  }, []);

  // ─── POLLING POUR RÉSULTAT DE CRÉATION ─────────────────────────────────────
  const pollForResult = useCallback(async (messageIds, groupId, maxAttempts = 60) => {
    const chatId = currentChatIdRef.current;
    if (!chatId) return { success: false, error: 'Chat non sélectionné' };

    let attempts = 0;
    const pollInterval = 2000; // 2 secondes

    while (attempts < maxAttempts) {
      attempts++;
      // Mise à jour progressive de la barre de progression (50% → 95%)
      const progress = Math.min(50 + (attempts / maxAttempts) * 45, 95);
      setActiveSubmissions(prev => ({
        ...prev,
        [groupId]: { ...prev[groupId], progress }
      }));

      try {
        // 🔄 Polling ROBUSTE : On demande l'état précis des messages par leurs IDs
        const res = await fetch(`/api/messages-status?ids=${messageIds.join(',')}`);
        const relevantMsgs = await res.json();

        // DEBUG: Log pour voir ce qui se passe
        if (attempts <= 3 || attempts % 10 === 0) {
          console.log(`[Poll #${attempts}] Cherche IDs:`, messageIds, '| Trouvés:', relevantMsgs.length, '| Erreur:', relevantMsgs.find(m => m.analysis_error)?.analysis_error || 'non');
        }

        // PRIORITÉ 1 : Chercher un SUCCÈS (real_property_id présent)
        const successMsg = relevantMsgs.find(msg => msg.real_property_id);
        if (successMsg) {
          return {
            success: true,
            propertyId: successMsg.real_property_id,
            neighborhood: successMsg.neighborhood,
            district: successMsg.district,
            municipality: successMsg.municipality
          };
        }

        // PRIORITÉ 2 : Chercher une ERREUR seulement si pas de succès
        const errorMsg = relevantMsgs.find(msg => msg.analysis_error);
        if (errorMsg) {
          const errors = [];
          const match = errorMsg.analysis_error.match(/Champs manquants:\s*(.+)/i);
          if (match) {
            const fields = match[1].split(',').map(f => f.trim());
            fields.forEach(f => errors.push({ field: f }));
          }
          return {
            success: false,
            error: errorMsg.analysis_error,
            errors: errors
          };
        }
      } catch (e) {
        console.error('Polling error:', e);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return { success: false, error: 'Timeout: La création prend trop de temps. Vérifiez plus tard.' };
  }, []);

  // ─── VÉRIFICATION DES MÉDIAS ─────────────────────────────────────────────────
  const verifyMediaFiles = useCallback(async (messageIds) => {
    // Récupérer les messages sélectionnés pour vérifier leurs médias
    const selectedMsgs = messages.filter(m => messageIds.includes(m.id));
    const mediaUrls = selectedMsgs
      .filter(m => m.has_media && m.media_path && m.media_mime_type?.startsWith('image/'))
      .map(m => '/' + m.media_path.replace('./', ''));

    const missingMedia = [];
    for (const url of mediaUrls) {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (!res.ok) missingMedia.push(url);
      } catch {
        missingMedia.push(url);
      }
    }

    return { valid: missingMedia.length === 0, missingCount: missingMedia.length };
  }, [messages]);


  // ─── ACTION MANUELLE (AVEC OVERLAY UX AMÉLIORÉ) ──────────────────────────────
  const handleManualAction = useCallback(async (action) => {
    if (selectedMessageIds.length === 0) return;
    const ids = [...selectedMessageIds];

    // Pour l'action "noise", on garde l'ancienne logique simple
    if (action === 'noise') {
      isManualActionRef.current = true;
      setTimeout(() => { isManualActionRef.current = false; }, 4000);

      setMessages(prev => prev.map(msg =>
        ids.includes(msg.id)
          ? { ...msg, property_group_id: 'noise' }
          : msg
      ));
      setSelectedMessageIds([]);

      try {
        const res = await fetch('/api/messages/manual-group', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds: ids, action })
        });
        const data = await res.json();
        if (!data.success) setToast({ message: data.error || "Erreur", type: 'error' });
        
        // Rafraîchir les compteurs non lus après l'action
        fetchChats();
      } catch (e) { console.error('noise action', e); }
      return;
    }

    // ─── CRÉATION DE BIEN (action === 'group') ─────────────────────────────────
    // 1. Verrou scroll et polling (pendant toute la durée de la soumission)
    isManualActionRef.current = true;
    setSelectedMessageIds([]);


    // 2. Générer un ID de groupe temporaire
    const pendingGroupId = `pending_${Date.now()}`;

    // ─── OPTIMISTIC UI IMMÉDIATE ───
    setMessages(prev => prev.map(msg =>
      ids.includes(msg.id)
        ? {
          ...msg,
          property_group_id: pendingGroupId,
          real_property_id: null,
          neighborhood: null,
          district: null,
          municipality: null,
          analysis_error: null
        }
        : msg
    ));

    // 3. Ajouter à activeSubmissions (mode non-bloquant)
    setActiveSubmissions(prev => ({
      ...prev,
      [pendingGroupId]: { status: 'verifying', progress: 0 }
    }));

    // 4. Vérifier les médias (peut prendre du temps si beaucoup d'images)
    const mediaCheck = await verifyMediaFiles(ids);
    if (!mediaCheck.valid) {
      setToast({ message: `❌ Échec : ${mediaCheck.missingCount} image(s) introuvables.`, type: 'error' });
      
      // RESET en cas d'échec de vérification immédiate
      setMessages(prev => prev.map(msg =>
        ids.includes(msg.id) ? { ...msg, property_group_id: null } : msg
      ));

      setActiveSubmissions(prev => {
        const newOnes = { ...prev };
        delete newOnes[pendingGroupId];
        return newOnes;
      });
      return;
    }

    setActiveSubmissions(prev => ({
      ...prev,
      [pendingGroupId]: { ...prev[pendingGroupId], status: 'sending', progress: 10 }
    }));

    try {
      // 6. Envoyer au backend
      const res = await fetch('/api/messages/submit-property', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds: ids, action: 'group' })
      });

      if (res.status === 202 || res.ok) {
        // 7. Passer à "processing" et commencer le polling
        setActiveSubmissions(prev => ({
          ...prev,
          [pendingGroupId]: { ...prev[pendingGroupId], status: 'processing', progress: 50 }
        }));

        const result = await pollForResult(ids, pendingGroupId);

        if (result.success) {
          // 8. Succès : transformer optimistic UI en real UI
          setMessages(prev => prev.map(msg =>
            ids.includes(msg.id)
              ? {
                ...msg,
                property_group_id: `real_prop_${result.propertyId}`,
                real_property_id: result.propertyId,
                neighborhood: result.neighborhood,
                district: result.district,
                municipality: result.municipality,
                analysis_error: null
              }
              : msg
          ));

          setToast({ message: `✅ Bien #${result.propertyId} créé avec succès !`, type: 'success' });
          
          // Rafraîchir les compteurs non lus immédiatement
          fetchChats();
          // Nettoyer après 1s
          setTimeout(() => {
            setActiveSubmissions(prev => {
              const newOnes = { ...prev };
              delete newOnes[pendingGroupId];
              return newOnes;
            });
          }, 1000);
        } else {
          // 9. Erreur : RESET demandé par l'utilisateur
          setToast({ message: `❌ Échec Création : ${result.error}`, type: 'error' });
          
          setMessages(prev => prev.map(msg =>
            ids.includes(msg.id)
              ? {
                ...msg,
                property_group_id: null,
                real_property_id: null,
                analysis_error: result.error
              }
              : msg
          ));

          setActiveSubmissions(prev => {
            const newOnes = { ...prev };
            delete newOnes[pendingGroupId];
            return newOnes;
          });
        }
      } else {
        const data = await res.json();
        throw new Error(data.error || 'Erreur serveur');
      }
    } catch (e) {
      console.error('submit error', e);
      setToast({ message: `❌ Erreur : ${e.message}`, type: 'error' });
      // RESET sur erreur réseau aussi
      setMessages(prev => prev.map(msg =>
        ids.includes(msg.id)
          ? { ...msg, property_group_id: null, real_property_id: null }
          : msg
      ));
      setActiveSubmissions(prev => {
        const newOnes = { ...prev };
        delete newOnes[pendingGroupId];
        return newOnes;
      });
    } finally {
      isManualActionRef.current = false;
    }

  }, [selectedMessageIds, messages, verifyMediaFiles, pollForResult]);

  // ─── SCROLL VER LE BAS ───────────────────────────────────────────────────────
  const scrollToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setShowScrollToBottom(false);
    }
  };

  // ─── RENDU DES BULLES (MEMOÏSÉ) ──────────────────────────────────────────────
  const groupedContent = useMemo(() => {
    const result = [];
    const groupWrappers = new Map(); // Map<groupId, WrapperObject>
    const processedGroupIds = new Set();

    // 1. Filtrer les messages (exclure moi et le bruit)
    const filteredMessages = messages.filter(msg => {
      const isFromMe = msg.is_from_me === true || msg.is_from_me === 1 || msg.is_from_me === "true";
      const isNoise = msg.property_group_id === 'noise';
      return !isFromMe && !isNoise;
    });

    // 2. Pré-calculer les groupes pour ceux qui ont un property_group_id
    filteredMessages.forEach(msg => {
      if (msg.property_group_id) {
        if (!groupWrappers.has(msg.property_group_id)) {
          const isRealProp = !!msg.real_property_id;
          let label = isRealProp ? `✅ BIEN CRÉÉ #${msg.real_property_id}` : '🏠 BIEN DÉTECTÉ (En attente)';

          if (isRealProp && (msg.neighborhood || msg.district)) {
            const locParts = [msg.neighborhood, msg.district, msg.municipality].filter(Boolean);
            if (locParts.length > 0) label += ` — 📍 ${locParts.join(' - ')}`;
          }

          groupWrappers.set(msg.property_group_id, {
            type: 'wrapper',
            label: msg.property_group_id.startsWith('ignore_') ? '🛑 À IGNORER' : label,
            key: msg.property_group_id,
            isCreated: isRealProp,
            propertyId: isRealProp ? msg.real_property_id : null,
            locationLabel: isRealProp && (msg.neighborhood || msg.district)
              ? ` — 📍 ${[msg.neighborhood, msg.district, msg.municipality].filter(Boolean).join(' - ')}`
              : '',
            children: []
          });
        }
      }
    });

    // 3. Aggregation des medias consécutifs (en respectant les groupes)
    const aggregatedMessages = [];
    let mediaBuffer = [];
    let lastGroupId = null;

    filteredMessages.forEach((msg, index) => {
      const isPureMedia = msg.has_media && (!msg.body || msg.body.trim() === '');
      const currentGroupId = msg.property_group_id;
      
      // On groupe si c'est pur media ET que c'est le même "parent" (groupe ou null)
      if (isPureMedia && (mediaBuffer.length === 0 || currentGroupId === lastGroupId)) {
        mediaBuffer.push(msg);
        lastGroupId = currentGroupId;
      } else {
        if (mediaBuffer.length > 2) {
          aggregatedMessages.push({ 
            type: 'media-batch', 
            messages: [...mediaBuffer], 
            id: `batch-${mediaBuffer[0].id}`,
            property_group_id: lastGroupId 
          });
        } else {
          mediaBuffer.forEach(m => aggregatedMessages.push(m));
        }
        mediaBuffer = isPureMedia ? [msg] : [];
        lastGroupId = isPureMedia ? currentGroupId : null;
        if (!isPureMedia) aggregatedMessages.push(msg);
      }

      if (index === filteredMessages.length - 1 && mediaBuffer.length > 0) {
        if (mediaBuffer.length > 2) {
          aggregatedMessages.push({ 
            type: 'media-batch', 
            messages: [...mediaBuffer], 
            id: `batch-${mediaBuffer[0].id}`,
            property_group_id: lastGroupId
          });
        } else {
          mediaBuffer.forEach(m => aggregatedMessages.push(m));
        }
      }
    });

    // 4. Construction du rendu en conservant l'ordre chronologique
    let lastSender = null, lastTimestamp = 0;
    let lastDateLabel = null;

    aggregatedMessages.forEach((item) => {
      const msg = item.type === 'media-batch' ? item.messages[0] : item;
      const dateLabel = getDateLabel(msg.timestamp);
      
      if (dateLabel !== lastDateLabel) {
        result.push({ type: 'date-header', label: dateLabel, key: `date-${msg.timestamp}` });
        lastDateLabel = dateLabel;
      }

      const isNewSender = msg.sender_id !== lastSender || (parseInt(msg.timestamp) - lastTimestamp > 300);
      const dateStr = new Date(parseInt(msg.timestamp) * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

      if (item.type === 'media-batch') {
        const ids = item.messages.map(m => m.id);
        const allSelected = ids.every(id => selectedMessageIds.includes(id));
        const isGrouped = !!item.property_group_id;

        const batchElement = (
          <div key={item.id} className="media-batch-container">
            {!isGrouped && (
              <input 
                type="checkbox" 
                className="msg-checkbox" 
                checked={allSelected} 
                onChange={() => toggleMultipleSelection(ids)} 
              />
            )}
            <div className="media-batch-grid">
              {item.messages.slice(0, 4).map((m, idx) => (
                <div key={m.id} className="media-batch-item">
                  {m.media_mime_type?.startsWith('image/') && <img src={'/' + m.media_path.replace('./', '')} alt="" />}
                  {idx === 3 && item.messages.length > 4 && (
                    <div className="media-batch-more">+{item.messages.length - 4}</div>
                  )}
                </div>
              ))}
            </div>
            <div className="media-batch-footer">
               Album: {item.messages.length} images
            </div>
          </div>
        );

        if (isGrouped) {
          const wrapper = groupWrappers.get(item.property_group_id);
          wrapper.children.push(batchElement);
          if (!processedGroupIds.has(item.property_group_id)) {
            result.push(wrapper);
            processedGroupIds.add(item.property_group_id);
          }
        } else {
          result.push(batchElement);
        }
      } else {
        const bubble = (
          <MessageBubble
            key={msg.id}
            msg={msg}
            isFirstInGroup={isNewSender}
            dateStr={dateStr}
            isSelected={selectedMessageIds.includes(msg.id)}
            onSelect={toggleMessageSelection}
          />
        );

        if (msg.property_group_id) {
          const wrapper = groupWrappers.get(msg.property_group_id);
          wrapper.children.push(bubble);
          if (!processedGroupIds.has(msg.property_group_id)) {
            result.push(wrapper);
            processedGroupIds.add(msg.property_group_id);
          }
        } else {
          result.push(bubble);
        }
      }

      lastSender = msg.sender_id;
      lastTimestamp = msg.timestamp;
    });

    return result;
  }, [messages, selectedMessageIds, toggleMessageSelection, toggleMultipleSelection]);

  const currentChatName = chats.find(c => c.whatsapp_chat_id === currentChatId)?.chat_name || currentChatId;


  // ─── RENDU ────────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">
      {/* Toast Notification */}
      {toast && (
        <div className={`toast-container ${toast.type}`}>
          <div className="toast-content">
            {toast.message}
            <button className="toast-close" onClick={() => setToast(null)}>✕</button>
          </div>
        </div>
      )}

      {/* QR Overlay */}
      {botStatus === 'QR' && qrCode && (
        <div className="qr-overlay">
          <div className="qr-card">
            <img src="/logo-locapay.png" alt="LocaPay" className="qr-logo" />
            <h1>Connectez WhatsApp</h1>
            <p>Scannez ce QR Code avec votre téléphone.</p>
            <div id="qrContainer"><QRCodeCanvas value={qrCode} size={250} marginSize={2} /></div>
            <div className="qr-status-text">Prêt pour le scan !</div>
          </div>
        </div>
      )}


      {/* Sidebar */}
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="avatar" style={{ borderRadius: '50%', overflow: 'hidden' }}>
            <img src="/logo-locapay.png" style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
          </div>
          <h2>Conversations</h2>
        </header>
        <div className="chat-list">
          {chats.map(chat => (
            <div key={chat.whatsapp_chat_id}
              className={`chat-item ${chat.whatsapp_chat_id === currentChatId ? 'active' : ''}`}
              onClick={() => handleSelectChat(chat.whatsapp_chat_id)}
            >
              <div className="avatar" style={{ background: getRandomColor(chat.chat_name || chat.whatsapp_chat_id) }}>
                {getInitials(chat.chat_name || chat.whatsapp_chat_id)}
              </div>
              <div className="chat-info">
                <div className="chat-top">
                  <div className="chat-title">{chat.chat_name || chat.whatsapp_chat_id}</div>
                  <div className="chat-time">{formatTime(chat.last_message_timestamp)}</div>
                </div>
                <div className="chat-bottom">
                  <div className="chat-preview">{chat.is_group ? 'Groupe' : 'Conversation'}</div>
                  {parseInt(chat.unread_count) > 0 && (
                    <div className="unread-badge">{chat.unread_count}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Zone principale */}
      <main className="chat-view">
        {currentChatId ? (
          <>
            <header className="chat-header">
              <div className="avatar" style={{ background: getRandomColor(currentChatName) }}>
                {getInitials(currentChatName)}
              </div>
              <div className="chat-header-info">
                <div className="name">{currentChatName}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {isLoadingMore ? 'Chargement...' : 'En ligne'}
                </div>
              </div>
            </header>

            <div className="messages-container" ref={containerRef} onScroll={handleScroll}>
              {/* Indicateur de chargement en haut */}
              {isLoadingMore && (
                <div style={{ textAlign: 'center', padding: '12px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  ⏳ Chargement des messages précédents...
                </div>
              )}
              {!hasMore && messages.length > 0 && (
                <div style={{ textAlign: 'center', padding: '12px', color: 'var(--text-muted)', fontSize: '12px' }}>
                  — Début de la conversation —
                </div>
              )}

               {/* Bulles */}
               {groupedContent.map((item, idx) => {
                 if (item?.type === 'date-header') {
                   return (
                     <div key={item.key || idx} className="date-header">
                       <span>{item.label}</span>
                     </div>
                   );
                 }
                  if (item?.type === 'wrapper') {
                    const isPending = item.key?.startsWith('pending_');
                    return (
                      <div key={item.key || idx} className={`property-group-wrapper ${item.isCreated ? 'created' : ''} ${isPending ? 'pending' : ''}`}>
                        <div className="property-group-header-label">
                          {item.propertyId ? (
                            <>
                              ✅ BIEN CRÉÉ{' '}
                              <a
                                href={`https://admin-locapay.vercel.app/properties/${item.propertyId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="property-link"
                              >
                                #{item.propertyId}
                              </a>
                              {item.locationLabel}
                            </>
                          ) : isPending ? (
                            <div className="pending-indicator">
                              <span className="pending-icon">
                                {activeSubmissions[item.key]?.status === 'verifying' ? '🔍' :
                                 activeSubmissions[item.key]?.status === 'sending' ? '📤' : '🤖'}
                              </span>
                              <span className="pending-text">
                                {activeSubmissions[item.key]?.status === 'verifying' ? 'Vérification...' :
                                 activeSubmissions[item.key]?.status === 'sending' ? 'Envoi...' : 'Analyse IA en cours...'}
                              </span>
                              <div className="pending-progress-container">
                                <div className="pending-progress-bar" style={{ width: `${activeSubmissions[item.key]?.progress || 0}%` }} />
                              </div>
                            </div>
                          ) : (
                            item.label
                          )}
                        </div>
                        <div className="property-group-content">
                          {item.children}
                        </div>
                      </div>
                    );
                  }
                 return item;
              })}
            </div>

            {/* Bouton nouveaux messages */}
            {showScrollToBottom && (
              <button
                className={`scroll-to-bottom-btn ${selectedMessageIds.length > 0 ? 'shifted' : ''}`}
                onClick={scrollToBottom}
              >
                👇 Nouveaux messages
              </button>
            )}

            {/* Barre d'action manuelle */}
            {selectedMessageIds.length > 0 && (
              <div className="manual-action-bar">
                <div className="selection-info">
                  <span>{selectedMessageIds.length}</span> sélectionné(s)
                  <div className="group-selection-container">
                    <input 
                      type="checkbox" 
                      id="groupSelection" 
                      checked={isGroupSelection} 
                      onChange={(e) => setIsGroupSelection(e.target.checked)} 
                    />
                    <label htmlFor="groupSelection" style={{ cursor: 'pointer' }}>Sélect. groupée</label>
                  </div>
                </div>
                <div className="action-buttons">
                  <button className="btn-action btn-noise" onClick={() => handleManualAction('noise')}>🗑️ Ignorer</button>
                  <button className="btn-action btn-group" onClick={() => handleManualAction('group')}>🚀 Créer le BIEN</button>
                  <button className="btn-action btn-cancel" onClick={() => setSelectedMessageIds([])}>✕</button>
                </div>
              </div>
            )}

            <div className="chat-input-area">
              <input type="text" placeholder="Écrire un message" disabled />
            </div>
          </>
        ) : (
          <div className="empty-state">
            <h1>WhatsApp Bot Dashboard</h1>
            <p>Sélectionnez une conversation pour commencer.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
