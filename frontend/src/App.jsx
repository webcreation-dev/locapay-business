import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import { QRCodeCanvas } from 'qrcode.react';

// Help functions (same as app.js)
const getInitials = (name) => {
  if (!name || name === 'Inconnu') return '?';
  return name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
};

const getRandomColor = (name) => {
  const colors = ['#00a884', '#007bff', '#6610f2', '#6f42c1', '#e83e8c', '#dc3545', '#fd7e14', '#ffc107', '#28a745', '#20c997', '#17a2b8'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

const formatTime = (timestamp) => {
  const date = new Date(parseInt(timestamp) * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
};

// -- COMPOSANT BULLE OPTIMISÉ (MEMO) --
// Empêche le saut de message : React ne rafraîchit pas ce composant sauf si l'état de sélection change.
const MessageBubble = memo(({ msg, isFirstInGroup, dateStr, isSelected, onSelect }) => {
  const bubbleClasses = [];
  if (msg.property_group_id === 'noise') bubbleClasses.push('noise');
  else if (msg.property_group_id) bubbleClasses.push('grouped');

  const mediaUrl = msg.media_path ? '/' + msg.media_path.replace('./', '') : null;

  return (
    <div className={`message-group ${isFirstInGroup ? 'first' : ''}`}>
        <div className="message-checkbox-container">
            {!msg.is_from_me && (
                <input 
                    type="checkbox" 
                    className="msg-checkbox" 
                    checked={isSelected}
                    onChange={() => onSelect(msg.id)}
                />
            )}
            <div className={`message ${msg.is_from_me ? 'out' : 'in'} ${isFirstInGroup ? 'first' : ''} ${bubbleClasses.join(' ')}`} 
                 style={{ width: 'fit-content', maxWidth: '320px' }}>
                {!msg.is_from_me && isFirstInGroup && (
                    <div className="sender-name" style={{ color: getRandomColor(msg.sender_name || 'Inconnu') }}>
                        {msg.sender_name || 'Inconnu'}
                    </div>
                )}
                <div className="message-content">
                    {msg.has_media && mediaUrl && (
                        <div className="media-container" style={{ minHeight: '150px' }}>
                            {msg.media_mime_type?.startsWith('image/') && <img src={mediaUrl} className="media-item large" loading="eager" />}
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
}, (prev, next) => {
  // On ne re-render QUE si l'état de sélection ou le contenu IA change.
  return prev.isSelected === next.isSelected && 
         prev.msg.property_group_id === next.msg.property_group_id &&
         prev.msg.body === next.msg.body;
});

function App() {
  const [chats, setChats] = useState([]);
  const [currentChatId, setCurrentChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [botStatus, setBotStatus] = useState('LOADING');
  const [qrCode, setQrCode] = useState(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const messagesContainerRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const prevScrollHeight = useRef(0);

  // Polling Chats
  useEffect(() => {
    const fetchChats = async () => {
      try {
        const res = await fetch('/api/chats');
        const data = await res.json();
        setChats(data);
      } catch (e) {
        console.error("Chats fetch failed", e);
      }
    };
    fetchChats();
    const int = setInterval(fetchChats, 4000);
    return () => clearInterval(int);
  }, []);

  // Polling Status & QR
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/status');
        const { status } = await res.json();
        setBotStatus(status);
        if (status === 'QR') {
          const qrRes = await fetch('/api/qr');
          const { qr } = await qrRes.json();
          setQrCode(qr);
        } else {
          setQrCode(null);
        }
      } catch (e) {
        console.error("Status fetch failed", e);
      }
    };
    fetchStatus();
    const int = setInterval(fetchStatus, 3000);
    return () => clearInterval(int);
  }, []);

  // Polling Messages
  useEffect(() => {
    if (!currentChatId) return;

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/messages/${currentChatId}`);
        const data = await res.json();
        
        if (messagesContainerRef.current) {
          const el = messagesContainerRef.current;
          isAtBottomRef.current = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
          prevScrollHeight.current = el.scrollHeight;
        }

        setMessages(data);
      } catch (e) {
        console.error("Messages fetch failed", e);
      }
    };

    fetchMessages();
    const int = setInterval(fetchMessages, 2000);
    return () => clearInterval(int);
  }, [currentChatId]);

  // Scroll logic after data change
  useEffect(() => {
    if (!messagesContainerRef.current) return;
    const el = messagesContainerRef.current;

    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowScrollToBottom(false);
    } else {
      if (el.scrollHeight > prevScrollHeight.current) {
        setShowScrollToBottom(true);
      }
    }
  }, [messages]);

  const scrollToBottom = () => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      setShowScrollToBottom(false);
    }
  };

  const handleScroll = () => {
    if (!messagesContainerRef.current) return;
    const el = messagesContainerRef.current;
    const isBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
    if (isBottom) setShowScrollToBottom(false);
  };

  const handleSelectChat = (id) => {
    setCurrentChatId(id);
    setSelectedMessageIds([]);
    setMessages([]);
    setShowScrollToBottom(false);
    isAtBottomRef.current = true;
  };

  // -- OPTIMISATION CLIC (useCallback) --
  const toggleMessageSelection = useCallback((id) => {
    setSelectedMessageIds(prev =>
      prev.includes(id) ? prev.filter(msgId => msgId !== id) : [...prev, id]
    );
  }, []);

  const handleManualAction = async (action) => {
    if (selectedMessageIds.length === 0) return;
    const idsToProcess = [...selectedMessageIds];

    // Optimistic UI update
    setMessages(prev => prev.map(msg => 
      idsToProcess.includes(msg.id) 
        ? { ...msg, property_group_id: action === 'noise' ? 'noise' : 'manual_fixed' } 
        : msg
    ));
    setSelectedMessageIds([]);

    try {
      const res = await fetch('/api/messages/manual-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds: idsToProcess, action })
      });
      const data = await res.json();
      if (!data.success) {
        alert(data.error || "Erreur lors de l'action");
      }
    } catch (e) {
      console.error("Manual action failed", e);
    }
  };

  // -- CALCUL DES GROUPES (useMemo) --
  const groupedContent = useMemo(() => {
    let lastGroupId = null;
    let lastSender = null;
    let lastTimestamp = 0;
    const groups = [];
    let currentPropertyWrapper = null;

    messages.forEach((msg) => {
        const isNewSender = msg.sender_id !== lastSender || (parseInt(msg.timestamp) - lastTimestamp > 300);
        const dateStr = new Date(parseInt(msg.timestamp) * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        if (msg.property_group_id && msg.property_group_id !== lastGroupId) {
            if (currentPropertyWrapper) groups.push(currentPropertyWrapper);
            if (msg.property_group_id !== 'noise') {
                const isToIgnore = msg.property_group_id.startsWith('ignore_');
                currentPropertyWrapper = {
                    type: 'property_wrapper',
                    label: isToIgnore ? '🛑 À IGNORER (VENTE/PARCELLE)' : '🏠 BIEN IMMOBILIER DÉTECTÉ',
                    isToIgnore,
                    children: []
                };
            } else {
                currentPropertyWrapper = null;
            }
        } else if (!msg.property_group_id && lastGroupId) {
            if (currentPropertyWrapper) groups.push(currentPropertyWrapper);
            currentPropertyWrapper = null;
        }

        const bubble = (
            <MessageBubble 
                key={msg.id} 
                msg={msg} 
                isFirstInGroup={isNewSender} 
                dateStr={dateStr}
                isSelected={selectedMessageIds.includes(msg.id)} // Dépendance isolée
                onSelect={toggleMessageSelection} // Callback stable
            />
        );

        if (currentPropertyWrapper) currentPropertyWrapper.children.push(bubble);
        else groups.push(bubble);

        lastGroupId = msg.property_group_id;
        lastSender = msg.sender_id;
        lastTimestamp = msg.timestamp;
    });

    if (currentPropertyWrapper) groups.push(currentPropertyWrapper);
    return groups;
  }, [messages, selectedMessageIds, toggleMessageSelection]);

  const currentChatName = chats.find(c => c.whatsapp_chat_id === currentChatId)?.chat_name || currentChatId;

  return (
    <div className="app-container">
      {/* QR Code Overlay */}
      {botStatus === 'QR' && qrCode && (
        <div className="qr-overlay" style={{ display: 'flex' }}>
          <div className="qr-card">
            <img src="/logo-locapay.png" alt="LocaPay" className="qr-logo" />
            <h1>Connectez WhatsApp</h1>
            <div id="qrContainer">
              <QRCodeCanvas value={qrCode} size={250} marginSize={2} />
            </div>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="avatar" style={{ borderRadius: '50%', overflow: 'hidden' }}>
            <img src="/logo-locapay.png" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <h2>Conversations</h2>
        </header>
        <div className="chat-list">
          {chats.map(chat => {
            const isActive = chat.whatsapp_chat_id === currentChatId;
            return (
              <div key={chat.whatsapp_chat_id}
                className={`chat-item ${isActive ? 'active' : ''}`} 
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
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main Content */}
      <main className="chat-view">
        {currentChatId ? (
          <>
            <header className="chat-header">
              <div className="avatar" style={{ background: getRandomColor(currentChatName) }}>
                {getInitials(currentChatName)}
              </div>
              <div className="chat-header-info">
                <div className="name">{currentChatName}</div>
              </div>
            </header>

            <div className="messages-container" ref={messagesContainerRef} onScroll={handleScroll}>
              {groupedContent.map((item, idx) => {
                if (item.type === 'property_wrapper') {
                  return (
                    <div key={idx} className={`property-group-wrapper ${item.isToIgnore ? 'to-ignore' : ''}`}>
                      <div className="property-group-header-label">{item.label}</div>
                      {item.children}
                    </div>
                  );
                }
                return item;
              })}
            </div>

            {showScrollToBottom && <button className="scroll-to-bottom-btn" onClick={scrollToBottom}>👇 Nouveau</button>}

            {selectedMessageIds.length > 0 && (
              <div className="manual-action-bar">
                <div className="selection-info"><span>{selectedMessageIds.length}</span> sélectionné(s)</div>
                <div className="action-buttons">
                  <button className="btn-action btn-noise" onClick={() => handleManualAction('noise')}>🗑️ Bruit</button>
                  <button className="btn-action btn-group" onClick={() => handleManualAction('group')}>🏠 Regrouper</button>
                  <button className="btn-action btn-cancel" onClick={() => setSelectedMessageIds([])}>X</button>
                </div>
              </div>
            )}
            
            <div className="chat-input-area"><input type="text" placeholder="Écrire un message" disabled /></div>
          </>
        ) : (
          <div className="empty-state"><h3>WhatsApp Web Bot</h3><p>Sélectionnez une conversation.</p></div>
        )}
      </main>
    </div>
  );
}

export default App;
