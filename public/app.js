let currentChatId = null;
let chatsInterval = null;
let messagesInterval = null;

const chatListEl = document.getElementById('chatList');
const msgsEl = document.getElementById('messagesContainer');
const chatHeader = document.getElementById('chatHeader');
const inputArea = document.getElementById('inputArea');
const headerName = document.getElementById('headerName');
const headerAvatar = document.getElementById('headerAvatar');
const qrOverlay = document.getElementById('qrOverlay');
const qrCanvas = document.getElementById('qrCanvas');

let lastQR = null;

async function checkStatus() {
    try {
        const res = await fetch('/api/status');
        const { status } = await res.json();
        
        if (status === 'QR') {
            qrOverlay.style.display = 'flex';
            const qrRes = await fetch('/api/qr');
            const { qr } = await qrRes.json();
            
            if (qr && qr !== lastQR) {
                lastQR = qr;
                QRCode.toCanvas(qrCanvas, qr, { width: 300, margin: 2 }, function (error) {
                    if (error) console.error(error);
                });
            }
        } else if (status === 'CONNECTED') {
            qrOverlay.style.display = 'none';
        }
    } catch (e) {
        console.error("Status fetch error:", e);
    }
}

// Check status every 2.5s
setInterval(checkStatus, 2500);
checkStatus();

function getInitials(name) {
    if (!name || name === 'Inconnu') return '?';
    return name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
}

function getRandomColor(name) {
    const colors = ['#00a884', '#007bff', '#6610f2', '#6f42c1', '#e83e8c', '#dc3545', '#fd7e14', '#ffc107', '#28a745', '#20c997', '#17a2b8'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

async function loadChats() {
    try {
        const res = await fetch('/api/chats');
        const chats = await res.json();
        
        if (chats.length === 0) {
            if (!currentChatId) chatListEl.innerHTML = '<div class="loading-state" style="height:auto">Aucune conversation</div>';
            return;
        }

        let newHTML = '';
        chats.forEach(chat => {
            const timeStr = formatTime(chat.last_message_timestamp);
            const initials = getInitials(chat.chat_name || chat.whatsapp_chat_id);
            const color = getRandomColor(chat.chat_name || chat.whatsapp_chat_id);
            
            newHTML += `
                <div class="chat-item ${chat.whatsapp_chat_id === currentChatId ? 'active' : ''}" onclick="selectChat('${chat.whatsapp_chat_id}', '${chat.chat_name ? chat.chat_name.replace(/'/g, "\\'") : chat.whatsapp_chat_id}')">
                    <div class="avatar" style="background:${color}">${initials}</div>
                    <div class="chat-info">
                        <div class="chat-top">
                            <div class="chat-title">${chat.chat_name || chat.whatsapp_chat_id}</div>
                            <div class="chat-time">${timeStr}</div>
                        </div>
                        <div class="chat-bottom">
                            <div class="chat-preview">${chat.is_group ? 'Groupe' : 'Message'}</div>
                        </div>
                    </div>
                </div>
            `;
        });

        chatListEl.innerHTML = newHTML;
    } catch (e) {
        console.error("Erreur chargement chats:", e);
    }
}

function formatTime(timestamp) {
    const date = new Date(parseInt(timestamp) * 1000);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
    }
    return date.toLocaleDateString('fr-FR', {day: '2-digit', month: '2-digit'});
}

async function selectChat(id, name) {
    currentChatId = id;
    chatHeader.style.display = 'flex';
    inputArea.style.display = 'flex';
    headerName.textContent = name;
    
    const initials = getInitials(name);
    const color = getRandomColor(name);
    headerAvatar.style.background = color;
    headerAvatar.textContent = initials;
    
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    
    await loadMessages(id);
    startMessagesPolling(id);
}

async function loadMessages(chatId) {
    try {
        const res = await fetch(`/api/messages/${chatId}`);
        const messages = await res.json();
        
        if (messages.length === 0) {
            msgsEl.innerHTML = '<div class="empty-state" style="height:auto"><h1>Aucun message</h1></div>';
            return;
        }

        let finalHTML = '';
        let lastSender = null;
        let lastTimestamp = 0;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const dateStr = new Date(parseInt(msg.timestamp) * 1000).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
            const isFirstInGroup = (msg.sender_id !== lastSender) || (parseInt(msg.timestamp) - lastTimestamp > 300);
            
            if (isFirstInGroup) {
                if (i !== 0) finalHTML += '</div>';
                finalHTML += '<div class="message-group">';
            }

            // --- DECTECTION GRID MEDIA ---
            let mediaBatch = [];
            if (msg.has_media && !msg.body) {
                let j = i;
                while (j < messages.length && messages[j].has_media && !messages[j].body && messages[j].sender_id === msg.sender_id) {
                    mediaBatch.push(messages[j]);
                    if (mediaBatch.length >= 20) break;
                    j++;
                }
            }

            if (mediaBatch.length > 1) {
                // Determine grid type
                let gridClass = 'quad';
                if (mediaBatch.length === 2) gridClass = 'double';
                if (mediaBatch.length === 3) gridClass = 'triple';

                const displayLimit = 4;
                const visibleBatch = mediaBatch.slice(0, displayLimit);
                const extraCount = mediaBatch.length - displayLimit;

                finalHTML += `
                    <div class="message ${msg.is_from_me ? 'out' : 'in'} ${isFirstInGroup ? 'first' : ''}" style="width: 250px; padding: 4px;">
                        ${!msg.is_from_me && isFirstInGroup ? `<div class="sender-name" style="margin: 5px 0 0 5px; color:${getRandomColor(msg.sender_name || 'Inconnu')}">${msg.sender_name || 'Inconnu'}</div>` : ''}
                        <div class="media-grid ${gridClass}">
                            ${visibleBatch.map((m, idx) => {
                                const mUrl = '/' + m.media_path.replace('./', '');
                                const isLast = idx === displayLimit - 1 && extraCount > 0;
                                
                                let tag = 'div';
                                let srcAttr = '';
                                if (m.media_mime_type.startsWith('image/')) { tag = 'img'; srcAttr = `src="${mUrl}"`; }
                                else if (m.media_mime_type.startsWith('video/')) { tag = 'video'; srcAttr = `src="${mUrl}"`; }

                                return `
                                    <div class="grid-item-container">
                                        <${tag} ${srcAttr} class="media-item"></${tag}>
                                        ${isLast ? `<div class="media-overlay">+${extraCount + 1}</div>` : ''}
                                    </div>
                                `;
                            }).join('')}
                        </div>
                        <div class="message-footer" style="padding: 0 5px 2px 0;"><span class="timestamp">${dateStr}</span></div>
                    </div>
                `;
                i += (mediaBatch.length - 1); 
            } else {
                // --- INDIVIDUAL RENDERING (CONSISTENT SIZE + CAPTION AT BOTTOM) ---
                let messageHTML = `
                    <div class="message ${msg.is_from_me ? 'out' : 'in'} ${isFirstInGroup ? 'first' : ''}" style="width:fit-content; max-width: 320px;">
                        ${!msg.is_from_me && isFirstInGroup ? `<div class="sender-name" style="color:${getRandomColor(msg.sender_name || 'Inconnu')}">${msg.sender_name || 'Inconnu'}</div>` : ''}
                        <div class="message-content">
                `;

                // Order: MEDIA FIRST
                if (msg.has_media && msg.media_path) {
                    const mediaUrl = '/' + msg.media_path.replace('./', '');
                    if (msg.media_mime_type && msg.media_mime_type.startsWith('image/')) {
                        messageHTML += `<img src="${mediaUrl}" class="media-item large" style="margin-bottom: ${msg.body ? '5px' : '0'}">`;
                    } else if (msg.media_mime_type && msg.media_mime_type.startsWith('video/')) {
                        messageHTML += `<video src="${mediaUrl}" controls class="media-item large" style="margin-bottom: ${msg.body ? '5px' : '0'}"></video>`;
                    } else if (msg.media_mime_type && msg.media_mime_type.startsWith('audio/')) {
                        messageHTML += `<audio src="${mediaUrl}" controls style="width:calc(100% + 10px); margin: 5px -5px 0 -5px; border-radius:100px; height:35px;"></audio>`;
                    } else {
                        messageHTML += `<div style="padding:8px; background:rgba(0,0,0,0.05); border-radius:8px; margin-bottom:5px;">📄 <a href="${mediaUrl}" target="_blank" style="color:var(--accent); text-decoration:none;">Fichier joint</a></div>`;
                    }
                }

                // THEN TEXT AT BOTTOM
                if (msg.body) {
                    messageHTML += `<div style="font-size: 14px; color: var(--text-main);">${msg.body.replace(/\n/g, '<br>')}</div>`;
                }

                messageHTML += `
                        </div>
                        <div class="message-footer">
                            <span class="timestamp">${dateStr}</span>
                        </div>
                    </div>
                `;
                finalHTML += messageHTML;
            }

            lastSender = msg.sender_id;
            lastTimestamp = parseInt(msg.timestamp);
        }

        finalHTML += '</div>';
        
        if (msgsEl.innerHTML !== finalHTML) {
            msgsEl.innerHTML = finalHTML;
            msgsEl.scrollTop = msgsEl.scrollHeight;
        }

    } catch (e) {
        console.error("Erreur chargement messages:", e);
    }
}

function startMessagesPolling(id) {
    if (messagesInterval) clearInterval(messagesInterval);
    messagesInterval = setInterval(() => {
        if (currentChatId === id) loadMessages(id);
    }, 2000);
}

loadChats();
setInterval(loadChats, 3000);
