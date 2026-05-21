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

const PAGE_SIZE = 100; // Messages chargés par page

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
const MessageBubble = memo(({ msg, isFirstInGroup, dateStr, isSelected, onSelect, viewMode }) => {
  // Conversion robuste de is_from_me en vrai booléen
  const isFromMe = msg.is_from_me === true || msg.is_from_me === 1 || msg.is_from_me === "true";
  const isNoise = msg.property_group_id === 'noise';
  const isGrouped = msg.property_group_id && !isNoise;
  const isPending = msg.property_group_id?.startsWith('pending_');
  const isRejected = msg.analysis_error != null;
  const mediaUrl = msg.media_path ? '/' + msg.media_path.replace('./', '') : null;

  let bubbleClass = `message ${isFromMe ? 'out' : 'in'} ${isFirstInGroup ? 'first' : ''}`.trim();

  // En mode analysis, on applique des classes spécifiques pour les couleurs
  if (viewMode === 'analysis') {
    if (isNoise) bubbleClass += ' status-noise';
    else if (isRejected) bubbleClass += ' status-rejected';
    else if (isGrouped) bubbleClass += ' status-analyzed';
    else if (isPending) bubbleClass += ' status-pending';
    else bubbleClass += ' status-none';
  } else {
    // Mode standard
    if (isNoise) bubbleClass += ' noise';
    if (isGrouped) bubbleClass += ' grouped';
  }

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

  // ─── NOUVEAUX ÉTATS (RECHERCHE & BIENS) ──────────────────────────────────────
  const [viewMode, setViewMode] = useState('full_access'); // 'chats', 'properties', 'rejected', 'pending', 'analysis' ou 'full_access'
  const [rejectedGroups, setRejectedGroups] = useState({ total: 0, by_error: {}, groups: [] });
  const [pendingGroups, setPendingGroups] = useState({ total: 0, groups: [] });
  const [isLoadingRejected, setIsLoadingRejected] = useState(false);
  const [isLoadingPending, setIsLoadingPending] = useState(false);
  const [expandedErrors, setExpandedErrors] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [properties, setProperties] = useState([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isLoadingProperties, setIsLoadingProperties] = useState(false);
  const [showCreatedOnly, setShowCreatedOnly] = useState(false);

  // --- STATS ET GROUPES FACEBOOK ---
  const [fbGroups, setFbGroups] = useState([]);
  const [currentFbGroupId, setCurrentFbGroupId] = useState(null);
  const [fbPosts, setFbPosts] = useState([]);
  const [fbStats, setFbStats] = useState(null);
  const [fbPostsStatus, setFbPostsStatus] = useState('all'); // all, pending, processed, error, noise
  const [fbNewGroupUrl, setFbNewGroupUrl] = useState('');
  const [fbNewGroupName, setFbNewGroupName] = useState('');
  const [fbIsLoadingGroups, setFbIsLoadingGroups] = useState(false);
  const [fbIsLoadingPosts, setFbIsLoadingPosts] = useState(false);
  const [fbIsSubmittingGroup, setFbIsSubmittingGroup] = useState(false);
  const [fbProgress, setFbProgress] = useState(null); // SSE progress info

  const containerRef = useRef(null);       // ref vers la div messages-container
  const scrollPositionBeforeSubmit = useRef(null); // Position scroll avant soumission
  const isManualActionRef = useRef(false);       // verrou : bloque le scroll auto après action manuelle
  const isInitialLoadingRef = useRef(false);      // verrou : bloque loadOlderMessages pendant le chargement initial
  const scrollMemory = useRef({});          // mémoire de scroll par chatId  { chatId: scrollTop }
  const lastNewMsgCount = useRef(0);           // nombre de messages la dernière fois
  const currentChatIdRef = useRef(null);        // valeur synchrone du chatId courant
  const pollingLockRef = useRef(false);       // évite les requêtes en double
  const shownErrorIdsRef = useRef(new Set());   // IDs des messages dont l'erreur a déjà été affichée
  const lastSelectedIdRef = useRef(null);       // Point de départ pour la sélection groupée
  const isGroupSelectionRef = useRef(false);    // Ref synchrone du mode groupé
  const messagesRef = useRef([]);               // Ref synchrone de la liste des messages

  // Synchronisation synchrone des refs pour garantir l'immédiateté pendant les interactions
  isGroupSelectionRef.current = isGroupSelection;
  messagesRef.current = messages;

  // ─── POLLING CHATS ──────────────────────────────────────────────────────────
  const fetchChats = useCallback(async () => {
    try {
      const endpoint = viewMode === 'full_access' ? '/api/full/chats' : '/api/chats';
      const response = await fetch(endpoint);
      const data = await response.json();
      setChats(data);
    } catch (e) {
      console.error('fetchChats error', e);
    }
  }, [viewMode]);

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

  // ─── EFFACER TOAST APRÈS 8s (sauf si persistent) ───────────────────────────
  useEffect(() => {
    if (toast && !toast.persistent) {
      const id = setTimeout(() => setToast(null), 8000);
      return () => clearTimeout(id);
    }
  }, [toast]);

  // ─── RECHERCHE DE MESSAGES ──────────────────────────────────────────────────
  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (searchTerm.length >= 2) {
        setIsSearching(true);
        try {
          const res = await fetch(`/api/messages/search?q=${encodeURIComponent(searchTerm)}`);
          const data = await res.json();
          setSearchResults(data);
        } catch (e) { console.error('search error', e); }
        finally { setIsSearching(false); }
      } else {
        setSearchResults([]);
      }
    }, 500);
    return () => clearTimeout(delayDebounceFn);
  }, [searchTerm]);

  // ─── RÉCUPÉRATION DES BIENS AGGRÉGÉS ────────────────────────────────────────
  const fetchProperties = useCallback(async () => {
    if (viewMode !== 'properties') return;
    setIsLoadingProperties(true);
    try {
      let url = '/api/properties/all';
      const params = new URLSearchParams();
      if (startDate) params.append('start', Math.floor(new Date(startDate).getTime() / 1000));
      if (endDate) params.append('end', Math.floor(new Date(endDate).getTime() / 1000));
      if (params.toString()) url += `?${params.toString()}`;

      const res = await fetch(url);
      const data = await res.json();
      setProperties(data);
    } catch (e) { console.error('fetchProperties error', e); }
    finally { setIsLoadingProperties(false); }
  }, [viewMode, startDate, endDate]);

  useEffect(() => {
    fetchProperties();
  }, [fetchProperties]);

  // ─── RÉCUPÉRATION DES GROUPES REJETÉS ─────────────────────────────────────────
  const fetchRejectedGroups = useCallback(async () => {
    setIsLoadingRejected(true);
    try {
      const res = await fetch('/api/rejected-groups');
      const data = await res.json();
      setRejectedGroups(data);
    } catch (e) { console.error('fetchRejectedGroups error', e); }
    finally { setIsLoadingRejected(false); }
  }, []);

  const fetchPendingGroups = useCallback(async () => {
    setIsLoadingPending(true);
    try {
      const res = await fetch('/api/pending-groups');
      const data = await res.json();
      setPendingGroups(data);
    } catch (e) { console.error('fetchPendingGroups error', e); }
    finally { setIsLoadingPending(false); }
  }, []);

  useEffect(() => {
    fetchRejectedGroups();
    const id = setInterval(fetchRejectedGroups, 10000);
    return () => clearInterval(id);
  }, [fetchRejectedGroups]);

  useEffect(() => {
    fetchPendingGroups();
    const id = setInterval(fetchPendingGroups, 10000);
    return () => clearInterval(id);
  }, [fetchPendingGroups]);

  // ─── GESTION FACEBOOK SCRAPER DATA ──────────────────────────────────────────
  const fetchFbGroups = useCallback(async () => {
    setFbIsLoadingGroups(true);
    try {
      const res = await fetch('/api/facebook/groups');
      const data = await res.json();
      setFbGroups(data);
    } catch (e) {
      console.error('fetchFbGroups error', e);
    } finally {
      setFbIsLoadingGroups(false);
    }
  }, []);

  const fetchFbStats = useCallback(async () => {
    try {
      const res = await fetch('/api/facebook/stats');
      const data = await res.json();
      setFbStats(data);
    } catch (e) {
      console.error('fetchFbStats error', e);
    }
  }, []);

  const fetchFbPosts = useCallback(async (groupId, status) => {
    setFbIsLoadingPosts(true);
    try {
      let url = `/api/facebook/posts?limit=100`;
      if (groupId) url += `&group_id=${encodeURIComponent(groupId)}`;
      if (status && status !== 'all') url += `&status=${status}`;
      
      const res = await fetch(url);
      const data = await res.json();
      setFbPosts(data.posts || []);
    } catch (e) {
      console.error('fetchFbPosts error', e);
    } finally {
      setFbIsLoadingPosts(false);
    }
  }, []);

  // Poll stats and groups if viewMode is facebook
  useEffect(() => {
    if (viewMode === 'facebook') {
      fetchFbGroups();
      fetchFbStats();
      const interval = setInterval(() => {
        fetchFbGroups();
        fetchFbStats();
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [viewMode, fetchFbGroups, fetchFbStats]);

  // Load posts whenever group or status tab changes
  useEffect(() => {
    if (viewMode === 'facebook') {
      fetchFbPosts(currentFbGroupId, fbPostsStatus);
    }
  }, [viewMode, currentFbGroupId, fbPostsStatus, fetchFbPosts]);

  // Add a new Facebook group
  const handleAddFbGroup = async (e) => {
    e.preventDefault();
    if (!fbNewGroupUrl.trim()) {
      setToast({ message: '⚠️ L\'URL du groupe est requise.', type: 'error' });
      return;
    }

    setFbIsSubmittingGroup(true);
    try {
      const res = await fetch('/api/facebook/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_url: fbNewGroupUrl.trim(),
          group_name: fbNewGroupName.trim() || undefined
        })
      });

      const data = await res.json();
      if (data.success && data.inserted > 0) {
        setToast({ message: `✅ Groupe Facebook ajouté avec succès !`, type: 'success' });
        setFbNewGroupUrl('');
        setFbNewGroupName('');
        fetchFbGroups();
        fetchFbStats();
      } else {
        const errorMsg = data.errors?.[0]?.error || data.error || 'Erreur inconnue';
        setToast({ message: `❌ Échec: ${errorMsg}`, type: 'error' });
      }
    } catch (err) {
      console.error('handleAddFbGroup error', err);
      setToast({ message: `❌ Erreur lors de l'ajout du groupe`, type: 'error' });
    } finally {
      setFbIsSubmittingGroup(false);
    }
  };

  // Run the batch processing via SSE
  const handleFbProcessAll = () => {
    if (fbProgress) return; // already running
    setFbProgress({ status: 'starting', message: 'Initialisation...' });

    const eventSource = new EventSource('/api/facebook/process-all');

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'progress') {
        setFbProgress({ status: 'processing', message: data.message });
      } else if (data.type === 'complete') {
        setToast({ message: data.message, type: 'success' });
        setFbProgress(null);
        fetchFbGroups();
        fetchFbStats();
        if (viewMode === 'facebook') {
          fetchFbPosts(currentFbGroupId, fbPostsStatus);
        }
        eventSource.close();
      } else if (data.type === 'error') {
        setToast({ message: `❌ ${data.message}`, type: 'error' });
        setFbProgress(null);
        eventSource.close();
      }
    };

    eventSource.onerror = () => {
      setToast({ message: "❌ Connexion perdue lors du traitement Facebook.", type: 'error' });
      setFbProgress(null);
      eventSource.close();
    };
  };

  // Retry processing a Facebook post
  const handleFbPostRetry = async (postId) => {
    try {
      setToast({ message: "⏳ Relance du traitement...", type: 'success' });
      const res = await fetch(`/api/facebook/posts/${encodeURIComponent(postId)}/retry`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setToast({ message: "🔄 Retry lancé en arrière-plan", type: 'success' });
        // actualiser après 1s
        setTimeout(() => {
          fetchFbGroups();
          fetchFbPosts(currentFbGroupId, fbPostsStatus);
        }, 1200);
      } else {
        throw new Error(data.error);
      }
    } catch (e) {
      setToast({ message: `❌ Échec du retry: ${e.message}`, type: 'error' });
    }
  };

  // Mark Facebook post as noise
  const handleFbPostNoise = async (postId) => {
    try {
      const res = await fetch(`/api/facebook/posts/${encodeURIComponent(postId)}/noise`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setToast({ message: "🗑️ Post marqué comme bruit", type: 'success' });
        fetchFbGroups();
        fetchFbStats();
        fetchFbPosts(currentFbGroupId, fbPostsStatus);
      } else {
        throw new Error(data.error);
      }
    } catch (e) {
      setToast({ message: `❌ Échec: ${e.message}`, type: 'error' });
    }
  };

  const handleRetryGroup = async (propertyGroupId) => {
    try {
      const res = await fetch(`/api/rejected-groups/${encodeURIComponent(propertyGroupId)}/retry`, { method: 'POST' });
      const data = await res.json();
      setToast({ message: `✅ ${data.message}`, type: 'success' });
      fetchRejectedGroups();
    } catch (e) {
      setToast({ message: `❌ Erreur: ${e.message}`, type: 'error' });
    }
  };

  const handleIgnoreGroup = async (propertyGroupId) => {
    try {
      const res = await fetch(`/api/rejected-groups/${encodeURIComponent(propertyGroupId)}/ignore`, { method: 'POST' });
      const data = await res.json();
      setToast({ message: `✅ ${data.message}`, type: 'success' });
      fetchRejectedGroups();
    } catch (e) {
      setToast({ message: `❌ Erreur: ${e.message}`, type: 'error' });
    }
  };

  const handleClearByError = async (errorLabel) => {
    if (!window.confirm(`Ignorer définitivement TOUS les groupes avec l'erreur :\n"${errorLabel}" ?`)) return;
    try {
      const res = await fetch(`/api/rejected-groups/clear-by-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errorLabel })
      });
      const data = await res.json();
      setToast({ message: `✅ ${data.message}`, type: 'success' });
      fetchRejectedGroups();
    } catch (e) {
      setToast({ message: `❌ Erreur: ${e.message}`, type: 'error' });
    }
  };

  // ─── POLLING MESSAGES (NOUVEAUX SEULEMENT) ───────────────────────────────────
  useEffect(() => {
    if (!currentChatId) return;
    currentChatIdRef.current = currentChatId;

    // Chargement initial
    const loadInitial = async () => {
      try {
        // 🔒 Activer le verrou : empêche loadOlderMessages de se déclencher pendant le chargement
        isInitialLoadingRef.current = true;

        // Déterminer le endpoint selon le mode
        const endpoint = viewMode === 'full_access' ? `/api/full/messages/${currentChatId}` : `/api/messages/${currentChatId}`;
        const data = await (await fetch(`${endpoint}?limit=${PAGE_SIZE}`)).json();
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

        const endpoint = viewMode === 'full_access' ? `/api/full/messages/${chatId}` : `/api/messages/${chatId}`;
        const data = await (await fetch(`${endpoint}?limit=${PAGE_SIZE}`)).json();
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
  }, [currentChatId, viewMode]);

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
      const endpoint = viewMode === 'full_access' ? `/api/full/messages/${currentChatId}` : `/api/messages/${currentChatId}`;
      const older = await (await fetch(`${endpoint}?limit=${PAGE_SIZE}&before=${oldestTimestamp}`)).json();
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
  }, [currentChatId, messages, isLoadingMore, hasMore, viewMode]);

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

  // ─── SÉLECTION DE MESSAGE (STABLE) ──────────────────────────────────────────
  const toggleMessageSelection = useCallback((id) => {
    setSelectedMessageIds(prev => {
      const isCurrentlySelected = prev.includes(id);
      const groupMode = isGroupSelectionRef.current;
      const lastId = lastSelectedIdRef.current;
      const currentMessages = messagesRef.current;

      // Si le mode sélection groupée est actif et qu'on a un point de référence
      if (groupMode && lastId && !isCurrentlySelected) {
        const startIdx = currentMessages.findIndex(m => m.id === lastId);
        const endIdx = currentMessages.findIndex(m => m.id === id);

        if (startIdx !== -1 && endIdx !== -1) {
          const range = currentMessages.slice(
            Math.min(startIdx, endIdx),
            Math.max(startIdx, endIdx) + 1
          );

          // On ne sélectionne que les messages éligibles
          const eligibleIds = range
            .filter(m => {
              const fromMe = m.is_from_me === true || m.is_from_me === 1 || m.is_from_me === "true";
              const grouped = m.property_group_id && m.property_group_id !== 'noise';
              return !fromMe && !grouped;
            })
            .map(m => m.id);

          lastSelectedIdRef.current = id;
          return [...new Set([...prev, ...eligibleIds])];
        }
      }

      // Comportement standard (toggle ou point de départ)
      lastSelectedIdRef.current = isCurrentlySelected ? null : id;
      return isCurrentlySelected ? prev.filter(x => x !== id) : [...prev, id];
    });
  }, []);

  // Nettoyage de la sélection quand on change de mode
  const handleToggleGroupSelection = (checked) => {
    setIsGroupSelection(checked);
    if (!checked) {
      setSelectedMessageIds([]); // Tout décocher si on quitte le mode groupé
      lastSelectedIdRef.current = null;
    }
  };

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
  const handleManualAction = useCallback(async (action, forcedIds = null) => {
    const ids = forcedIds || selectedMessageIds;
    if (ids.length === 0) return;

    // Pour l'action "noise", on garde l'ancienne logique simple
    if (action === 'noise') {
      isManualActionRef.current = true;
      setTimeout(() => { isManualActionRef.current = false; }, 4000);

      setMessages(prev => prev.map(msg =>
        ids.includes(msg.id)
          ? { ...msg, property_group_id: 'noise' }
          : msg
      ));
      if (!forcedIds) setSelectedMessageIds([]);

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
    if (!forcedIds) setSelectedMessageIds([]);


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
      // En mode analyse ou accès total, on garde TOUT
      if (viewMode === 'analysis' || viewMode === 'full_access') return true;

      const isFromMe = msg.is_from_me === true || msg.is_from_me === 1 || msg.is_from_me === "true";
      const isNoise = msg.property_group_id === 'noise';
      // Si on filtre, on regarde si le real_property_id est là ou pas
      const isCreated = msg.real_property_id !== null && msg.real_property_id !== undefined;

      if (showCreatedOnly) {
        return !isFromMe && !isNoise && isCreated;
      } else {
        // Mode normal : cacher les déjà créés
        return !isFromMe && !isNoise && !isCreated;
      }
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

          const isAutoProp = msg.property_group_id.startsWith('auto_prop_');
          const isAiProp = msg.property_group_id.startsWith('ia_prop_') || msg.property_group_id.startsWith('prop_');

          groupWrappers.set(msg.property_group_id, {
            type: 'wrapper',
            label: msg.property_group_id.startsWith('ignore_') ? '🛑 À IGNORER' : label,
            key: msg.property_group_id,
            isCreated: isRealProp,
            isAutoSuggestion: !isRealProp && isAutoProp,
            isAiSuggestion: !isRealProp && (isAiProp || !isAutoProp),
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
      const isPureMedia = msg.has_media && msg.media_path && (!msg.body || msg.body.trim() === '');
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
                  {m.media_mime_type?.startsWith('image/') && m.media_path && <img src={'/' + m.media_path.replace('./', '')} alt="" />}
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
          if (wrapper) {
            wrapper.children.push({ type: 'media', element: batchElement, timestamp: item.messages[0].timestamp });
            if (!processedGroupIds.has(item.property_group_id)) {
              result.push(wrapper);
              processedGroupIds.add(item.property_group_id);
            }
          } else {
            result.push(batchElement);
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
            viewMode={viewMode}
          />
        );

        if (msg.property_group_id) {
          const wrapper = groupWrappers.get(msg.property_group_id);
          if (wrapper) {
            wrapper.children.push({ type: 'text', element: bubble, timestamp: msg.timestamp, hasMedia: !!msg.has_media });
            if (!processedGroupIds.has(msg.property_group_id)) {
              result.push(wrapper);
              processedGroupIds.add(msg.property_group_id);
            }
          } else {
            result.push(bubble);
          }
        } else {
          result.push(bubble);
        }
      }

      lastSender = msg.sender_id;
      lastTimestamp = msg.timestamp;
    });

    return result;
  }, [messages, selectedMessageIds, toggleMessageSelection, toggleMultipleSelection, showCreatedOnly, viewMode]);

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
          <div className="sidebar-controls">
            <button
              className="refresh-fab"
              title="Lancer le traitement automatique (Purge + Groupage + Soumission)"
              onClick={async () => {
                if (!window.confirm("Lancer le workflow automatique complet ?\n\n1. Purge du bruit\n2. Groupement IA\n3. Soumission à NestJS")) return;
                
                setToast({ message: "⚡ Initialisation du workflow...", type: 'success', persistent: true });
                
                const eventSource = new EventSource('/api/chats/full-workflow');
                
                eventSource.onmessage = (event) => {
                  const data = JSON.parse(event.data);
                  if (data.type === 'progress') {
                    setToast({ message: data.message, type: 'success', persistent: true });
                  } else if (data.type === 'complete') {
                    setToast({ message: data.message, type: 'success' });
                    fetchChats();
                    eventSource.close();
                  } else if (data.type === 'error') {
                    setToast({ message: `❌ ${data.message}`, type: 'error' });
                    eventSource.close();
                  }
                };

                eventSource.onerror = () => {
                  setToast({ message: "❌ Connexion perdue", type: 'error' });
                  eventSource.close();
                };
              }}
            >
              🚀
            </button>
            {/* <button
              className={`view-toggle ${viewMode === 'chats' ? 'active' : ''}`}
              onClick={() => { setViewMode('chats'); setSearchTerm(''); }}
            >
              💬
            </button>
            <button
              className={`view-toggle ${viewMode === 'properties' ? 'active' : ''}`}
              onClick={() => { setViewMode('properties'); setSearchTerm(''); }}
            >
              🏠
            </button>
            <button
              className={`view-toggle ${viewMode === 'pending' ? 'active' : ''}`}
              onClick={() => { setViewMode('pending'); setSearchTerm(''); }}
              title="Annonces détectées (Attentes)"
            >
              📂
            </button> 
            <button
              className={`view-toggle ${viewMode === 'analysis' ? 'active' : ''}`}
              onClick={() => { setViewMode('analysis'); setSearchTerm(''); }}
              title="Vue Analytique"
              style={{ position: 'relative' }}
            >
              📊
              {pendingGroups.total > 0 && (
                <div className="unread-badge header-badge">{pendingGroups.total}</div>
              )}
            </button>
            <button
              className={`view-toggle ${viewMode === 'rejected' ? 'active' : ''}`}
              onClick={() => { setViewMode('rejected'); setSearchTerm(''); }}
              title="Groupes rejetés"
            >
              ⚠️
            </button> */}
            <button
              className={`view-toggle ${viewMode === 'facebook' ? 'active' : ''}`}
              onClick={() => { setViewMode('facebook'); setSearchTerm(''); }}
              title="Pipeline Facebook"
            >
              📘
            </button>
            <button
              className={`view-toggle ${viewMode === 'full_access' ? 'active' : ''}`}
              onClick={() => { setViewMode('full_access'); setSearchTerm(''); }}
              title="Accès Total (Tout voir)"
            >
              🔓
            </button>
          </div>
        </header>

        {/* Barre de recherche */}
        <div className="sidebar-search">
          <div className="search-input-wrapper">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder={viewMode === 'chats' ? "Rechercher dans les biens..." : "Filtrer la liste..."}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && <button className="clear-search" onClick={() => setSearchTerm('')}>✕</button>}
          </div>
        </div>

        <div className="chat-list">
          {(viewMode === 'chats' || viewMode === 'analysis' || viewMode === 'full_access') ? (
            searchTerm.length >= 2 ? (
              /* Résultats de recherche */
              <div className="search-results">
                {isSearching ? (
                  <div className="search-loading">Recherche en cours...</div>
                ) : searchResults.length === 0 ? (
                  <div className="search-empty">Aucun message trouvé</div>
                ) : (
                  searchResults.map(msg => (
                    <div key={msg.id} className="search-result-item" onClick={() => { handleSelectChat(msg.chat_id); setSearchTerm(''); }}>
                      <div className="result-header">
                        <span className="result-chat">{msg.chat_name}</span>
                        <span className="result-time">{formatTime(msg.timestamp)}</span>
                      </div>
                      <div className="result-body">{msg.body}</div>
                      {msg.real_property_id && <div className="result-tag">#BIEN {msg.real_property_id}</div>}
                    </div>
                  ))
                )}
              </div>
            ) : (
              /* Liste des conversations classiques */
              chats.map(chat => (
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
              ))
            )
          ) : viewMode === 'facebook' ? (
            /* Liste des groupes Facebook dans la sidebar */
            <div className="sidebar-properties-list" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
              <div style={{ padding: '12px 15px', fontSize: '12px', fontWeight: '700', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-lighter)', background: '#f8fafc', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                <span>GROUPES FACEBOOK</span>
                <span className="fb-badge-mini total">{fbGroups.length}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <div
                  className={`chat-item ${currentFbGroupId === null ? 'active' : ''}`}
                  onClick={() => setCurrentFbGroupId(null)}
                  style={{ height: '60px' }}
                >
                  <div className="avatar" style={{ background: '#475569', fontSize: '14px', width: '36px', height: '36px', marginRight: '12px' }}>
                    🌐
                  </div>
                  <div className="chat-info">
                    <div className="chat-title" style={{ fontSize: '13px', fontWeight: '600' }}>Tous les Groupes</div>
                    <div className="chat-preview" style={{ fontSize: '11px' }}>Vue globale & statistiques</div>
                  </div>
                </div>
                {fbGroups.filter(g => !searchTerm || g.group_name.toLowerCase().includes(searchTerm.toLowerCase()) || g.group_id.includes(searchTerm)).map(group => (
                  <div
                    key={group.group_id}
                    className={`chat-item ${currentFbGroupId === group.group_id ? 'active' : ''}`}
                    onClick={() => setCurrentFbGroupId(group.group_id)}
                    style={{ height: '65px', padding: '0 12px' }}
                  >
                    <div className="avatar" style={{ background: '#1877f2', fontSize: '14px', width: '36px', height: '36px', marginRight: '12px' }}>
                      👥
                    </div>
                    <div className="chat-info" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <div className="chat-title" style={{ fontSize: '12.5px', fontWeight: '600' }} title={group.group_name}>
                        {group.group_name}
                      </div>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {parseInt(group.pending) > 0 && <span className="fb-badge-mini pending" style={{ padding: '0px 4px', fontSize: '9px' }}>{group.pending}</span>}
                        {parseInt(group.errors) > 0 && <span className="fb-badge-mini error" style={{ padding: '0px 4px', fontSize: '9px' }}>{group.errors}</span>}
                        {parseInt(group.processed) > 0 && <span className="fb-badge-mini processed" style={{ padding: '0px 4px', fontSize: '9px' }}>{group.processed}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* Liste simplifiée des biens dans la sidebar (optionnel si on utilise la zone principale) */
            <div className="sidebar-properties-list">
              <div style={{ padding: '15px', color: '#667781', fontSize: '13px' }}>
                Mode "Liste des Biens" actif
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Zone principale */}
      <main className="chat-view">
        {viewMode === 'facebook' ? (
          <div className="fb-dashboard">
            <header className="chat-header fb-header" style={{ justifyContent: 'space-between' }}>
              <div className="chat-header-info">
                <div className="name" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>📘 Pipeline Facebook Scraper</span>
                  {fbProgress && <span className="pending-icon">⚙️</span>}
                </div>
                <div className="subtitle">
                  {currentFbGroupId ? `Groupe ID: ${currentFbGroupId}` : "Tableau de bord global des imports"}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  className="btn-fb-primary"
                  onClick={handleFbProcessAll}
                  disabled={!!fbProgress}
                  style={{ opacity: fbProgress ? 0.7 : 1 }}
                >
                  🚀 {fbProgress ? "Traitement..." : "Traiter tous les posts"}
                </button>
              </div>
            </header>

            <div className="messages-container" style={{ flex: 1, padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* SSE Progress Notification */}
              {fbProgress && (
                <div className="fb-sse-progress-container">
                  <div className="fb-sse-status">⚡ {fbProgress.message}</div>
                  <div className="fb-sse-progress-wrapper">
                    <div className="fb-sse-progress-bar" style={{ width: fbProgress.status === 'starting' ? '10%' : '60%', animation: 'pulse 1s infinite alternate' }}></div>
                  </div>
                </div>
              )}

              {/* Global Stats or Add form */}
              {currentFbGroupId === null && (
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px' }}>
                  {/* Left: Stats grid */}
                  <div>
                    <h3 style={{ fontSize: '12px', fontWeight: '700', color: 'var(--text-muted)', marginBottom: '12px', textTransform: 'uppercase' }}>Statistiques Globales</h3>
                    <div className="fb-stats-grid" style={{ padding: 0 }}>
                      <div className="fb-stat-card blue">
                        <span className="fb-stat-title">Total Posts</span>
                        <span className="fb-stat-value">{fbStats?.total || 0}</span>
                      </div>
                      <div className="fb-stat-card orange">
                        <span className="fb-stat-title">En Attente</span>
                        <span className="fb-stat-value">{fbStats?.pending || 0}</span>
                      </div>
                      <div className="fb-stat-card green">
                        <span className="fb-stat-title">Traités (Biens)</span>
                        <span className="fb-stat-value">{fbStats?.processed || 0}</span>
                      </div>
                      <div className="fb-stat-card red">
                        <span className="fb-stat-title">Erreurs</span>
                        <span className="fb-stat-value">{fbStats?.errors || 0}</span>
                      </div>
                      <div className="fb-stat-card gray">
                        <span className="fb-stat-title">Bruits</span>
                        <span className="fb-stat-value">{fbStats?.noise || 0}</span>
                      </div>
                    </div>

                    <div style={{ marginTop: '25px', background: '#ffffff', padding: '20px', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}>
                      <h4 style={{ fontSize: '13.5px', fontWeight: '700', marginBottom: '10px', color: '#1e293b' }}>ℹ️ Comment importer de nouveaux posts ?</h4>
                      <p style={{ fontSize: '12.5px', color: '#64748b', lineHeight: '1.6' }}>
                        1. Récupérez le fichier d'export JSON depuis votre scraper de groupe Facebook Apify.<br />
                        2. Utilisez directement l'API HTTP `POST /api/facebook/upload` (avec le fichier dans le champ `file`).<br />
                        3. Les posts seront automatiquement pré-filtrés : s'ils datent de plus de 24h ou s'ils n'ont aucun média attaché, ils seront directement classés en <strong>Bruit</strong> d'office pour préserver vos requêtes OpenAI.<br />
                        4. Utilisez ce tableau de bord pour superviser les posts restants, voir les erreurs d'analyse de l'IA, ou forcer des re-traitements.
                      </p>
                    </div>
                  </div>

                  {/* Right: Quick add group form */}
                  <div className="fb-add-card">
                    <div className="fb-add-title">
                      <span>👥 Ajouter un Groupe</span>
                    </div>
                    <form onSubmit={handleAddFbGroup} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <div className="fb-form-group">
                        <label>URL du groupe Facebook (ou ID)</label>
                        <input
                          type="text"
                          className="fb-input"
                          placeholder="https://www.facebook.com/groups/..."
                          value={fbNewGroupUrl}
                          onChange={(e) => setFbNewGroupUrl(e.target.value)}
                          required
                        />
                      </div>
                      <div className="fb-form-group">
                        <label>Nom du Groupe (Facultatif)</label>
                        <input
                          type="text"
                          className="fb-input"
                          placeholder="Ex: Mon Groupe Immo"
                          value={fbNewGroupName}
                          onChange={(e) => setFbNewGroupName(e.target.value)}
                        />
                      </div>
                      <button
                        type="submit"
                        className="btn-fb-primary"
                        style={{ marginTop: '5px' }}
                        disabled={fbIsSubmittingGroup}
                      >
                        {fbIsSubmittingGroup ? "Ajout..." : "Enregistrer"}
                      </button>
                    </form>
                  </div>
                </div>
              )}

              {/* Group Posts viewer section */}
              {(currentFbGroupId !== null || (fbStats && parseInt(fbStats.total) > 0)) && (
                <div className="fb-posts-section">
                  <div className="fb-posts-header">
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-main)' }}>
                        {currentFbGroupId ? `Posts du groupe: ${fbGroups.find(g => g.group_id === currentFbGroupId)?.group_name || currentFbGroupId}` : "Tous les Posts"}
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        Affichage des 100 derniers posts triés par date d'extraction
                      </span>
                    </div>

                    <div className="fb-posts-filter-tabs">
                      {['all', 'pending', 'processed', 'error', 'noise'].map(tab => (
                        <button
                          key={tab}
                          className={`fb-filter-tab ${fbPostsStatus === tab ? 'active' : ''}`}
                          onClick={() => setFbPostsStatus(tab)}
                        >
                          {tab === 'all' && 'Tout'}
                          {tab === 'pending' && 'En Attente'}
                          {tab === 'processed' && 'Traités'}
                          {tab === 'error' && 'Erreurs'}
                          {tab === 'noise' && 'Bruits'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="fb-posts-grid">
                    {fbIsLoadingPosts ? (
                      <div className="loading-state">Chargement des posts...</div>
                    ) : fbPosts.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>
                        Aucun post trouvé pour ce filtre.
                      </div>
                    ) : (
                      fbPosts.map(post => (
                        <div key={post.post_id} className="fb-post-card">
                          <div className="fb-post-card-header">
                            <div>
                              <span className="fb-post-author">{post.author || "Auteur inconnu"}</span>
                              {post.group_name && <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '8px' }}>({post.group_name})</span>}
                            </div>
                            <span className="fb-post-date">{post.estimated_post_at ? new Date(post.estimated_post_at).toLocaleString('fr-FR') : "Date inconnue"}</span>
                          </div>

                          <div className="fb-post-body">{post.text}</div>

                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                            {post.image_urls && JSON.parse(post.image_urls).length > 0 && (
                              <div className="fb-post-media-indicator">
                                🖼️ {JSON.parse(post.image_urls).length} image(s)
                              </div>
                            )}
                            {post.video_url && (
                              <div className="fb-post-media-indicator">
                                🎥 Vidéo
                              </div>
                            )}
                            {post.phone_extracted && (
                              <span className="fb-phone-badge">
                                📞 Extrait: {post.phone_extracted}
                              </span>
                            )}
                            {post.is_processed && (
                              <span className="fb-badge-mini processed">✅ BIEN CRÉÉ #{post.real_property_id}</span>
                            )}
                            {post.is_noise && (
                              <span className="fb-badge-mini noise" style={{ textDecoration: 'none' }}>🗑️ Bruit</span>
                            )}
                            {post.analysis_error && (
                              <span className="fb-badge-mini error" title={post.analysis_error}>⚠️ Erreur: {post.analysis_error}</span>
                            )}
                            {!post.is_processed && !post.is_noise && !post.analysis_error && (
                              <span className="fb-badge-mini pending">⏳ En attente de traitement</span>
                            )}
                          </div>

                          {/* Quick Actions */}
                          {(!post.is_processed) && (
                            <div className="fb-post-actions">
                              <button
                                  className="fb-btn-action-mini retry"
                                  onClick={() => handleFbPostRetry(post.post_id)}
                              >
                                🔄 Retraiter
                              </button>
                              {!post.is_noise && (
                                <button
                                  className="fb-btn-action-mini noise"
                                  onClick={() => handleFbPostNoise(post.post_id)}
                                >
                                  🗑️ Ignorer
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : viewMode === 'properties' ? (
          <div className="properties-dashboard">
            <header className="chat-header properties-header">
              <div className="chat-header-info">
                <div className="name">Tous les Biens Créés</div>
                <div className="subtitle">Exploration croisée par période</div>
              </div>
              <div className="date-filter-panel">
                <div className="filter-group">
                  <span className="filter-label">Du</span>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="date-input" />
                </div>
                <div className="filter-group">
                  <span className="filter-label">au</span>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="date-input" />
                </div>
                <button className="refresh-fab" onClick={fetchProperties} title="Refresh">
                  🔄
                </button>
              </div>
            </header>

            <div className="messages-container">
              {isLoadingProperties ? (
                <div className="loading-state">Chargement des biens...</div>
              ) : properties.length === 0 ? (
                <div className="empty-state">
                  <h1>Aucun bien trouvé</h1>
                  <p>Ajustez vos filtres de dates ou créez votre premier bien.</p>
                </div>
              ) : (
                properties.map(property => (
                  <div key={property.real_property_id} className="property-group-wrapper created">
                    <div className="property-group-header-label">
                      ✅ BIEN CRÉÉ{' '}
                      <a
                        href={`https://admin-locapay.vercel.app/properties/${property.real_property_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="property-link"
                      >
                        #{property.real_property_id}
                      </a>
                      {(property.neighborhood || property.district) && (
                        ` — 📍 ${[property.neighborhood, property.district, property.municipality].filter(Boolean).join(' - ')}`
                      )}
                    </div>
                    <div className="property-group-content">
                      {/* Séparation des médias et du texte pour un affichage "Album" */}
                      {(() => {
                        const textMsgs = property.messages.filter(m => m.body && m.body.trim());

                        return (
                          <div className="property-texts">
                            {textMsgs.map(msg => (
                              <div key={msg.id} className="property-text-item">
                                <div className="msg-body">{msg.body}</div>
                                <div className="msg-meta">{msg.sender_name} • {formatTime(msg.timestamp)}</div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : viewMode === 'pending' ? (
          <div className="rejected-dashboard">
            <header className="chat-header properties-header">
              <div className="chat-header-info">
                <div className="name">Annonces Détectées</div>
                <div className="subtitle">{pendingGroups.total} groupes en attente de validation</div>
              </div>
              <button className="refresh-fab" onClick={fetchPendingGroups} title="Actualiser">
                🔄
              </button>
            </header>

            <div className="messages-container rejected-list">
              {isLoadingPending ? (
                <div className="loading-state">Chargement des attentes...</div>
              ) : pendingGroups.total === 0 ? (
                <div className="empty-state">
                  <h1>Aucune détection en attente</h1>
                  <p>Bravo ! Toutes les annonces ont été traitées.</p>
                </div>
              ) : (
                <div className="pending-groups-list" style={{ padding: '20px' }}>
                  {pendingGroups.groups.map(group => (
                    <div key={group.property_group_id} className="rejected-group-item pending-item" style={{ borderLeft: '4px solid #3b82f6' }}>
                      <div className="rejected-group-header">
                        <span className="rejected-group-chat" style={{ color: '#2563eb' }}>{group.chat_name || group.chat_id}</span>
                        <span className="rejected-group-count">{group.message_count} msg • {new Date(group.first_message_at * 1000).toLocaleString()}</span>
                      </div>
                      {group.description && (
                        <div className="rejected-group-description" style={{ maxHeight: '150px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {group.description}
                        </div>
                      )}
                      <div className="rejected-group-actions">
                        <button
                          className="btn-create-direct"
                          onClick={async () => {
                            try {
                              setToast({ message: "🚀 Création du bien...", type: 'success' });
                              const res = await fetch(`/api/messages/submit-group/${encodeURIComponent(group.property_group_id)}`, { method: 'POST' });
                              const data = await res.json();
                              setToast({ message: "✅ Bien créé avec succès", type: 'success' });
                              fetchPendingGroups();
                            } catch (e) {
                              setToast({ message: "❌ Échec de création", type: 'error' });
                            }
                          }}
                        >
                          🚀 Créer le BIEN
                        </button>
                        <button
                          className="btn-ignore"
                          onClick={async () => {
                            if (!window.confirm("Ignorer cette annonce ?")) return;
                            await handleIgnoreGroup(group.property_group_id);
                            fetchPendingGroups();
                          }}
                        >
                          🗑️ Ignorer
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : viewMode === 'rejected' ? (
          <div className="rejected-dashboard">
            <header className="chat-header properties-header">
              <div className="chat-header-info">
                <div className="name">Groupes Rejetés</div>
                <div className="subtitle">{rejectedGroups.total} groupes avec erreurs</div>
              </div>
              <button className="refresh-fab" onClick={fetchRejectedGroups} title="Actualiser">
                🔄
              </button>
            </header>

            <div className="messages-container rejected-list">
              {isLoadingRejected ? (
                <div className="loading-state">Chargement des rejets...</div>
              ) : rejectedGroups.total === 0 ? (
                <div className="empty-state">
                  <h1>Aucun groupe rejeté</h1>
                  <p>Tous les groupes ont été traités avec succès.</p>
                </div>
              ) : (
                Object.entries(rejectedGroups.by_error).map(([error, groups]) => (
                  <div key={error} className="error-category">
                    <div className="error-category-header">
                      <div className="error-info" onClick={() => setExpandedErrors(prev => ({ ...prev, [error]: !prev[error] }))} style={{ flex: 1, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <span className="error-toggle">{expandedErrors[error] ? '▼' : '▶'}</span>
                        <span className="error-message">{error}</span>
                        <span className="error-count">{groups.length} groupes</span>
                      </div>
                      <button
                        className="btn-clear-error"
                        onClick={(e) => { e.stopPropagation(); handleClearByError(error); }}
                        title="Ignorer TOUS les groupes pour cette erreur"
                      >
                        🗑️ Tout ignorer
                      </button>
                    </div>
                    {expandedErrors[error] && (
                      <div className="error-groups-list">
                        {groups.map(group => (
                          <div key={group.property_group_id} className="rejected-group-item">
                            <div className="rejected-group-header">
                              <span className="rejected-group-chat">{group.chat_name || group.chat_id}</span>
                              <span className="rejected-group-count">{group.message_count} msg</span>
                            </div>
                            {group.description && (
                              <div className="rejected-group-description">{group.description}</div>
                            )}
                            <div className="rejected-group-actions">
                              <button
                                className="btn-retry"
                                onClick={() => handleRetryGroup(group.property_group_id)}
                                title="Réessayer ce groupe"
                              >
                                🔄 Réessayer
                              </button>
                              <button
                                className="btn-ignore"
                                onClick={() => handleIgnoreGroup(group.property_group_id)}
                                title="Ignorer définitivement"
                              >
                                🗑️ Ignorer
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : currentChatId ? (
          <>
            <header className="chat-header">
              <div className="avatar" style={{ background: getRandomColor(currentChatName) }}>
                {getInitials(currentChatName)}
              </div>
              <div className="chat-header-info">
                <div className="name">
                  {currentChatName} {viewMode === 'full_access' && '🔓'}
                </div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {viewMode === 'full_access' ? 'Vue Sans Restriction' : (isLoadingMore ? 'Chargement...' : 'En ligne')}
                  </div>
                  {viewMode !== 'full_access' && (() => {
                    const pendingCount = groupedContent.filter(item => item.type === 'wrapper' && !item.isCreated).length;
                    return (
                      <div style={{
                        backgroundColor: pendingCount === 0 ? '#667781' : '#3b82f6',
                        color: 'white',
                        padding: '4px 8px',
                        borderRadius: '12px',
                        fontSize: '11px',
                        fontWeight: '600',
                        opacity: pendingCount === 0 ? 0.6 : 1
                      }}>
                        📂 {pendingCount} groupe détectés
                      </div>
                    );
                  })()}
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
              {(() => {
                const FORBIDDEN_PATTERN = /vendre|vente|parcelle|terrain|titre\sfoncier|\stf\s|\stf\n|domaine|\stf$|opportunite|recherche/i;
                return groupedContent.filter(item => {
                  // En mode 'analysis' ou 'full_access', on ne filtre RIEN !
                  if (viewMode === 'analysis' || viewMode === 'full_access') return true;

                  // 1. Cacher les détections déjà dans le Dashboard 📂
                  if (viewMode === 'chats' && item.type === 'wrapper' && !item.isCreated) {
                    return false;
                  }
                  // 2. Cacher les messages bruts qui contiennent "vente/tf" ou trop courts sans média
                  if (viewMode === 'chats' && item.type === 'message' && item.msg?.body) {
                    const body = item.msg.body.normalize('NFKD').replace(/[\u0300-\u036f]/g, "");
                    // Bruit ou Vente
                    const isLongEnough = item.msg.hasMedia || body.length >= 20;
                    if (FORBIDDEN_PATTERN.test(body) || !isLongEnough) {
                      return false;
                    }
                  }
                  return true;
                }).map((item, idx) => {
                  if (item?.type === 'date-header') {
                    return (
                      <div key={item.key || idx} className="date-header">
                        <span>{item.label}</span>
                      </div>
                    );
                  }
                  if (item?.type === 'wrapper') {
                    const isPending = !item.isCreated;
                    const isAi = item.isAiSuggestion;
                    return (
                      <div
                        key={item.key || idx}
                        className={`property-group-wrapper ${item.isCreated ? 'created' : ''} ${isPending ? 'pending' : ''}`}
                        style={isAi ? { border: '2px dashed #3b82f6', backgroundColor: '#eff6ff' } : {}}
                      >
                        <div className="property-group-header-label" style={isAi ? { color: '#2563eb', fontWeight: 'bold' } : {}}>
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
                            <div className="property-group-header-suggestion" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                              <div className="suggestion-status">
                                {activeSubmissions[item.key] ? (
                                  <div className="pending-indicator">
                                    <span className="pending-icon">
                                      {activeSubmissions[item.key].status === 'verifying' ? '🔍' : '📤'}
                                    </span>
                                    <span className="pending-text">
                                      {activeSubmissions[item.key].status === 'verifying' ? 'Vérification...' : 'Creation...'}
                                    </span>
                                  </div>
                                ) : (
                                  item.isAutoSuggestion ? (
                                    <span className="suggestion-label auto">🤖 DÉTECTION AUTO (#{item.key})</span>
                                  ) : (
                                    <span className="suggestion-label ai">🧠 SUGGESTION IA (#{item.key})</span>
                                  )
                                )}
                              </div>

                              {!activeSubmissions[item.key] && (
                                <>
                                  <button
                                    className="btn-action btn-noise"
                                    onClick={() => {
                                      const groupMsgIds = messages.filter(m => m.property_group_id === item.key).map(m => m.id);
                                      if (groupMsgIds.length > 0) {
                                        handleManualAction('noise', groupMsgIds);
                                      }
                                    }}
                                  >
                                    🗑️ Ignorer
                                  </button>
                                  <button
                                    className="btn-action btn-create-direct"
                                    onClick={() => {
                                      const groupMsgIds = messages.filter(m => m.property_group_id === item.key).map(m => m.id);
                                      if (groupMsgIds.length > 0) {
                                        handleManualAction('group', groupMsgIds);
                                      }
                                    }}
                                  >
                                    🚀 Créer un bien
                                  </button>
                                </>
                              )}
                            </div>
                          ) : item.label}
                        </div>
                        <div className="property-group-content">
                          {item.children
                            .sort((a, b) => {
                              // 1. Priorité au texte SANS média (la description principale)
                              const isTextA = a.type === 'text' && !a.hasMedia;
                              const isTextB = b.type === 'text' && !b.hasMedia;
                              if (isTextA && !isTextB) return -1;
                              if (!isTextA && isTextB) return 1;
                              // 2. Sinon ordre chronologique croissant (du plus vieux au plus récent)
                              return a.timestamp - b.timestamp;
                            })
                            .map((child, cIdx) => (
                              <React.Fragment key={cIdx}>{child.element}</React.Fragment>
                            ))
                          }
                        </div>
                      </div>
                    );
                  }
                  return item;
                })
              })()
              }
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
                      onChange={(e) => handleToggleGroupSelection(e.target.checked)}
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
