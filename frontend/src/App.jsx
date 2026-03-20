import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import { QRCodeCanvas } from 'qrcode.react';

// ─── UTILITAIRES ──────────────────────────────────────────────────────────────
const getInitials = (name) => {
  if (!name || name === 'Inconnu') return '?';
  return name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
};

const getRandomColor = (name = '') => {
  const colors = ['#00a884','#007bff','#6610f2','#6f42c1','#e83e8c','#dc3545','#fd7e14','#ffc107','#28a745','#20c997','#17a2b8'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
};

const formatTime = (timestamp) => {
  const date = new Date(parseInt(timestamp) * 1000);
  const now  = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
};

const PAGE_SIZE = 30; // Messages chargés par page

// ─── COMPOSANT BULLE (MÉMOÏSÉ STRICTEMENT) ────────────────────────────────────
const MessageBubble = memo(({ msg, isFirstInGroup, dateStr, isSelected, onSelect }) => {
  // Conversion robuste de is_from_me en vrai booléen
  const isFromMe  = msg.is_from_me === true || msg.is_from_me === 1 || msg.is_from_me === "true";
  const isNoise   = msg.property_group_id === 'noise';
  const isGrouped = msg.property_group_id && !isNoise;
  const mediaUrl  = msg.media_path ? '/' + msg.media_path.replace('./', '') : null;

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
        {!isFromMe && (
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
  const [chats,              setChats]              = useState([]);
  const [currentChatId,      setCurrentChatId]      = useState(null);
  const [messages,           setMessages]            = useState([]);
  const [botStatus,          setBotStatus]           = useState('LOADING');
  const [qrCode,             setQrCode]              = useState(null);
  const [selectedMessageIds, setSelectedMessageIds]  = useState([]);
  const [showScrollToBottom, setShowScrollToBottom]  = useState(false);
  const [isLoadingMore,      setIsLoadingMore]       = useState(false);
  const [hasMore,            setHasMore]             = useState(true);

  const containerRef       = useRef(null);       // ref vers la div messages-container
  const isManualActionRef  = useRef(false);       // verrou : bloque le scroll auto après action manuelle
  const isInitialLoadingRef = useRef(false);      // verrou : bloque loadOlderMessages pendant le chargement initial
  const scrollMemory       = useRef({});          // mémoire de scroll par chatId  { chatId: scrollTop }
  const lastNewMsgCount    = useRef(0);           // nombre de messages la dernière fois
  const currentChatIdRef   = useRef(null);        // valeur synchrone du chatId courant
  const pollingLockRef     = useRef(false);       // évite les requêtes en double

  // ─── POLLING CHATS ──────────────────────────────────────────────────────────
  useEffect(() => {
    const fetch_ = async () => {
      try { setChats(await (await fetch('/api/chats')).json()); }
      catch(e) { console.error('chats', e); }
    };
    fetch_();
    const id = setInterval(fetch_, 4000);
    return () => clearInterval(id);
  }, []);

  // ─── POLLING STATUS / QR ─────────────────────────────────────────────────────
  useEffect(() => {
    const fetch_ = async () => {
      try {
        const { status } = await (await fetch('/api/status')).json();
        setBotStatus(status);
        if (status === 'QR') { const { qr } = await (await fetch('/api/qr')).json(); setQrCode(qr); }
        else setQrCode(null);
      } catch(e) { console.error('status', e); }
    };
    fetch_();
    const id = setInterval(fetch_, 3000);
    return () => clearInterval(id);
  }, []);

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
      } catch(e) { console.error('init messages', e); isInitialLoadingRef.current = false; }
    };
    loadInitial();

    // Polling léger : uniquement les NOUVEAUX messages (timestamp > dernier)
    const poll = setInterval(async () => {
      if (pollingLockRef.current) return;
      pollingLockRef.current = true;
      try {
        const chatId = currentChatIdRef.current;
        if (!chatId) return;
        const data = await (await fetch(`/api/messages/${chatId}?limit=${PAGE_SIZE}`)).json();
        setMessages(prev => {
          if (data.length === prev.length) {
            // Même nombre de messages : on met juste à jour property_group_id si changé
            const hasChange = data.some((d, i) => d.property_group_id !== prev[i]?.property_group_id);
            return hasChange ? data : prev;
          }
          if (data.length > prev.length) {
            // Nouveaux messages arrivés
            return data;
          }
          return prev;
        });
        setHasMore(data.length === PAGE_SIZE);
      } catch(e) { console.error('poll messages', e); }
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
    const oldScrollTop    = el.scrollTop;
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
    } catch(e) { console.error('load older', e); }
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
    setSelectedMessageIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }, []);

  // ─── ACTION MANUELLE (CHAP-CHAP) ─────────────────────────────────────────────
  const handleManualAction = useCallback(async (action) => {
    if (selectedMessageIds.length === 0) return;
    const ids = [...selectedMessageIds];

    // Verrou scroll : pendant 4 secondes après l'action, aucun auto-scroll
    isManualActionRef.current = true;
    setTimeout(() => { isManualActionRef.current = false; }, 4000);

    // Optimistic UI
    setMessages(prev => prev.map(msg =>
      ids.includes(msg.id)
        ? { ...msg, property_group_id: action === 'noise' ? 'noise' : 'manual_fixed' }
        : msg
    ));
    setSelectedMessageIds([]);

    try {
      const res  = await fetch('/api/messages/manual-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds: ids, action })
      });
      const data = await res.json();
      if (!data.success) alert(data.error || "Erreur lors de l'action");
    } catch(e) { console.error('manual action', e); }
  }, [selectedMessageIds]);

  // ─── SCROLL VER LE BAS ───────────────────────────────────────────────────────
  const scrollToBottom = () => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setShowScrollToBottom(false);
    }
  };

  // ─── RENDU DES BULLES (MEMOÏSÉ) ──────────────────────────────────────────────
  const groupedContent = useMemo(() => {
    let lastGroupId = null, lastSender = null, lastTimestamp = 0;
    const result = [];
    let wrapper  = null;

    messages.forEach((msg) => {
      const isNewSender = msg.sender_id !== lastSender || (parseInt(msg.timestamp) - lastTimestamp > 300);
      const dateStr = new Date(parseInt(msg.timestamp) * 1000)
        .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

      // Gestion des blocs propriété (IA)
      if (msg.property_group_id && msg.property_group_id !== lastGroupId) {
        if (wrapper) result.push(wrapper);
        if (msg.property_group_id !== 'noise') {
          wrapper = {
            type: 'wrapper',
            label: msg.property_group_id.startsWith('ignore_') ? '🛑 À IGNORER' : '🏠 BIEN DÉTECTÉ',
            key: msg.property_group_id,
            children: []
          };
        } else { wrapper = null; }
      } else if (!msg.property_group_id && lastGroupId) {
        if (wrapper) result.push(wrapper);
        wrapper = null;
      }

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

      if (wrapper) wrapper.children.push(bubble);
      else result.push(bubble);

      lastGroupId = msg.property_group_id;
      lastSender  = msg.sender_id;
      lastTimestamp = msg.timestamp;
    });

    if (wrapper) result.push(wrapper);
    return result;
  }, [messages, selectedMessageIds, toggleMessageSelection]);

  const currentChatName = chats.find(c => c.whatsapp_chat_id === currentChatId)?.chat_name || currentChatId;

  // ─── RENDU ────────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">
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
                if (item?.type === 'wrapper') {
                  return (
                    <div key={item.key || idx} className="property-group-wrapper">
                      <div className="property-group-header-label">{item.label}</div>
                      {item.children}
                    </div>
                  );
                }
                return item;
              })}
            </div>

            {/* Bouton nouveaux messages */}
            {showScrollToBottom && (
              <button className="scroll-to-bottom-btn" onClick={scrollToBottom}>
                👇 Nouveaux messages
              </button>
            )}

            {/* Barre d'action manuelle */}
            {selectedMessageIds.length > 0 && (
              <div className="manual-action-bar">
                <div className="selection-info">
                  <span>{selectedMessageIds.length}</span> sélectionné(s)
                </div>
                <div className="action-buttons">
                  <button className="btn-action btn-noise"  onClick={() => handleManualAction('noise')}>🗑️ Ignorer</button>
                  <button className="btn-action btn-group"  onClick={() => handleManualAction('group')}>🏠 Regrouper</button>
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
