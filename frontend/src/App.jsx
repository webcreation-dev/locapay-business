import React, { useState, useEffect, useRef, useMemo } from 'react';
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
        
        // Before state updates, check if we are at the bottom
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
    return () => {
        clearInterval(int);
    };
  }, [currentChatId]);

  // Scroll logic after data change
  useEffect(() => {
    if (!messagesContainerRef.current) return;
    const el = messagesContainerRef.current;

    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowScrollToBottom(false);
    } else {
      // If content grew but we weren't at bottom, show the button
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
    if (isBottom) {
      setShowScrollToBottom(false);
    }
  };

  const handleSelectChat = (id, name) => {
    setCurrentChatId(id);
    setSelectedMessageIds([]);
    setMessages([]);
    setShowScrollToBottom(false);
    isAtBottomRef.current = true;
  };

  const toggleMessageSelection = (id) => {
    setSelectedMessageIds(prev =>
      prev.includes(id) ? prev.filter(msgId => msgId !== id) : [...prev, id]
    );
  };

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
        // Reload messages on error to sync with server
        const syncRes = await fetch(`/api/messages/${currentChatId}`);
        setMessages(await syncRes.json());
      }
    } catch (e) {
      console.error("Manual action failed", e);
    }
  };

  const currentChat = chats.find(c => c.whatsapp_chat_id === currentChatId);

  return (
    <div className="app-container">
      {/* QR Code Overlay */}
      {botStatus === 'QR' && qrCode && (
        <div id="qrOverlay" className="qr-overlay" style={{ display: 'flex' }}>
          <div className="qr-card">
            <img src="/logo-locapay.png" alt="LocaPay" className="qr-logo" />
            <h1>Connectez WhatsApp</h1>
            <p>Scannez ce QR Code avec votre téléphone pour activer LocaPay Web Bot.</p>
            <div id="qrContainer">
              <QRCodeCanvas value={qrCode} size={250} marginSize={2} />
            </div>
            <div id="qrStatus" className="qr-status-text">Prêt pour le scan !</div>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="avatar" style={{ width: '40px', height: '40px', borderRadius: '50%', overflow: 'hidden' }}>
            <img src="/logo-locapay.png" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <h2>Conversations</h2>
        </header>
        <div className="chat-list" id="chatList">
          {chats.length === 0 ? (
            <div className="loading-state">Initialisation...</div>
          ) : (
            chats.map(chat => {
              const isActive = chat.whatsapp_chat_id === currentChatId;
              const initials = getInitials(chat.chat_name || chat.whatsapp_chat_id);
              const color = getRandomColor(chat.chat_name || chat.whatsapp_chat_id);
              return (
                <div 
                  key={chat.whatsapp_chat_id}
                  className={`chat-item ${isActive ? 'active' : ''}`} 
                  onClick={() => handleSelectChat(chat.whatsapp_chat_id, chat.chat_name)}
                >
                  <div className="avatar" style={{ background: color }}>{initials}</div>
                  <div className="chat-info">
                    <div className="chat-top">
                      <div className="chat-title">{chat.chat_name || chat.whatsapp_chat_id}</div>
                      <div className="chat-time">{formatTime(chat.last_message_timestamp)}</div>
                    </div>
                    <div className="chat-bottom">
                      <div className="chat-preview">{chat.is_group ? 'Groupe' : 'Message'}</div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="chat-view">
        {currentChatId ? (
          <>
            <header className="chat-header" id="chatHeader">
              <div className="avatar" style={{ background: getRandomColor(currentChat?.chat_name || currentChatId) }}>
                {getInitials(currentChat?.chat_name || currentChatId)}
              </div>
              <div className="chat-header-info">
                <div className="name">{currentChat?.chat_name || currentChatId}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>En ligne</div>
              </div>
            </header>

            <div 
              className="messages-container" 
              ref={messagesContainerRef}
              onScroll={handleScroll}
            >
              {messages.length === 0 ? (
                <div className="empty-state" style={{ height: 'auto' }}><h1>Aucun message</h1></div>
              ) : (
                <MessageBubbles 
                  messages={messages} 
                  selectedMessageIds={selectedMessageIds} 
                  toggleMessageSelection={toggleMessageSelection} 
                />
              )}
            </div>

            {showScrollToBottom && (
              <button className="scroll-to-bottom-btn" onClick={scrollToBottom}>
                👇 Nouveaux messages
              </button>
            )}

            {selectedMessageIds.length > 0 && (
              <div className="manual-action-bar">
                <div className="selection-info">
                  <span>{selectedMessageIds.length}</span> message(s) sélectionné(s)
                </div>
                <div className="action-buttons">
                  <button className="btn-action btn-noise" onClick={() => handleManualAction('noise')}>🗑️ Ignorer (Bruit)</button>
                  <button className="btn-action btn-group" onClick={() => handleManualAction('group')}>🏠 Regrouper (Bien)</button>
                  <button className="btn-action btn-cancel" onClick={() => setSelectedMessageIds([])}>Annuler</button>
                </div>
              </div>
            )}

            <div className="chat-input-area">
                <svg viewBox="0 0 24 24" width="24" height="24" stroke="var(--text-muted)" strokeWidth="2" fill="none"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"></path></svg>
                <svg viewBox="0 0 24 24" width="24" height="24" stroke="var(--text-muted)" strokeWidth="2" fill="none"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
                <input type="text" placeholder="Écrire un message" disabled />
                <svg viewBox="0 0 24 24" width="24" height="24" stroke="var(--text-muted)" strokeWidth="2" fill="none"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"></path></svg>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <svg width="250" height="250" viewBox="0 0 500 500" style={{ opacity: 0.3 }}>
              <circle cx="250" cy="250" r="240" fill="#202c33" />
              <path d="M150 150 L350 350 M350 150 L150 350" stroke="#8696a0" strokeWidth="15" />
            </svg>
            <h1>WhatsApp Web Bot</h1>
            <p>Sélectionnez une conversation pour commencer.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function MessageBubbles({ messages, selectedMessageIds, toggleMessageSelection }) {
  let lastGroupId = null;
  let lastSender = null;
  let lastTimestamp = 0;
  
  const groups = [];
  let currentGroup = [];
  let currentPropertyWrapper = null;

  messages.forEach((msg, idx) => {
    const isNewSender = msg.sender_id !== lastSender || (parseInt(msg.timestamp) - lastTimestamp > 300);
    const dateStr = new Date(parseInt(msg.timestamp) * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

    // Handle Property Grouping (IA or Manual)
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

    const messageBubble = (
        <MessageBubble 
            key={msg.id} 
            msg={msg} 
            isFirstInGroup={isNewSender} 
            dateStr={dateStr}
            isSelected={selectedMessageIds.includes(msg.id)}
            onSelect={() => toggleMessageSelection(msg.id)}
        />
    );

    if (currentPropertyWrapper) {
        currentPropertyWrapper.children.push(messageBubble);
    } else {
        groups.push(messageBubble);
    }

    lastGroupId = msg.property_group_id;
    lastSender = msg.sender_id;
    lastTimestamp = msg.timestamp;
  });

  if (currentPropertyWrapper) groups.push(currentPropertyWrapper);

  return (
    <>
      {groups.map((group, idx) => {
        if (group.type === 'property_wrapper') {
          return (
            <div key={idx} className={`property-group-wrapper ${group.isToIgnore ? 'to-ignore' : ''}`}>
              <div className="property-group-header-label">{group.label}</div>
              {group.children}
            </div>
          );
        }
        return group;
      })}
    </>
  );
}

function MessageBubble({ msg, isFirstInGroup, dateStr, isSelected, onSelect }) {
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
                    onChange={onSelect}
                />
            )}
            <div className={`message ${msg.is_from_me ? 'out' : 'in'} ${isFirstInGroup ? 'first' : ''} ${bubbleClasses.join(' ')}`} style={{ width: 'fit-content', maxWidth: '320px' }}>
                {!msg.is_from_me && isFirstInGroup && (
                    <div className="sender-name" style={{ color: getRandomColor(msg.sender_name || 'Inconnu') }}>
                        {msg.sender_name || 'Inconnu'}
                    </div>
                )}
                <div className="message-content">
                    {msg.has_media && mediaUrl && (
                        <div className="media-container">
                            {msg.media_mime_type?.startsWith('image/') && <img src={mediaUrl} className="media-item large" />}
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
}

export default App;
