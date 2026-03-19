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
let lastChatListHTML = '';
let lastMessagesHTML = '';

async function checkStatus() {
    try {
        const res = await fetch('/api/status');
        const { status } = await res.json();
        
        if (status === 'QR') {
            if (qrOverlay.style.display !== 'flex') qrOverlay.style.display = 'flex';
            const qrRes = await fetch('/api/qr');
            const { qr } = await qrRes.json();
            
            if (qr && qr !== lastQR) {
                lastQR = qr;
                QRCode.toCanvas(qrCanvas, qr, { width: 300, margin: 2 }, function (error) {
                    if (error) console.error(error);
                });
            }
        } else if (status === 'CONNECTED') {
            if (qrOverlay.style.display !== 'none') qrOverlay.style.display = 'none';
        }
    } catch (e) {
        console.error("Status check failed:", e);
    }
}

// Check status every 3s (QR presence)
setInterval(checkStatus, 3000);
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
            if (!currentChatId) chatListEl.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted)">Aucune conversation</div>';
            return;
        }

        let newHTML = '';
        chats.forEach(chat => {
            const timeStr = formatTime(chat.last_message_timestamp);
            const initials = getInitials(chat.chat_name || chat.whatsapp_chat_id);
            const color = getRandomColor(chat.chat_name || chat.whatsapp_chat_id);
            
            newHTML += `
                <div class="chat-item ${chat.whatsapp_chat_id === currentChatId ? 'active' : ''}" onclick="selectChat('${chat.whatsapp_chat_id}', '${(chat.chat_name || '').replace(/'/g, "\\'")}')">
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

        // Anti-clignotement Sidebar
        if (chatListEl.innerHTML !== newHTML) {
            chatListEl.innerHTML = newHTML;
        }
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
    if (currentChatId === id) return; // Déjà sélectionné

    currentChatId = id;
    chatHeader.style.display = 'flex';
    inputArea.style.display = 'flex';
    headerName.textContent = name || id;
    
    const initials = getInitials(name || id);
    const color = getRandomColor(name || id);
    headerAvatar.style.background = color;
    headerAvatar.textContent = initials;
    
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    
    // Clear last messages to force scroll to bottom on new selection
    msgsEl.innerHTML = ''; 
    lastMessagesHTML = '';
    delete msgsEl.dataset.initialized;
    
    await loadMessages(id);
    startMessagesPolling(id);
}

let selectedMessageIds = [];

async function loadMessages(chatId) {
    if (currentChatId !== chatId) return;

    try {
        const res = await fetch(`/api/messages/${chatId}`);
        const messages = await res.json();
        
        if (messages.length === 0) {
            msgsEl.innerHTML = '<div class="empty-state" style="height:auto"><h1>Aucun message</h1></div>';
            return;
        }

        let finalHTML = '';
        let lastGroupId = null;
        let lastSender = null;
        let lastTimestamp = 0;
        let isInsidePropertyBlock = false;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const dateStr = new Date(parseInt(msg.timestamp) * 1000).toLocaleTimeString('fr-FR', {hour: '2-digit', minute:'2-digit'});
            
            // Détection de changement de groupe de propriété (IA ou Manuel)
            if (msg.property_group_id && msg.property_group_id !== lastGroupId) {
                if (isInsidePropertyBlock) {
                    finalHTML += '</div>'; 
                    isInsidePropertyBlock = false;
                }

                if (msg.property_group_id !== 'noise') {
                    const isToIgnore = msg.property_group_id.startsWith('ignore_');
                    const label = isToIgnore ? '🛑 À IGNORER (VENTE/PARCELLE)' : '🏠 BIEN IMMOBILIER DÉTECTÉ';
                    finalHTML += `
                        <div class="property-group-wrapper ${isToIgnore ? 'to-ignore' : ''}">
                            <div class="property-group-header-label">${label}</div>
                    `;
                    isInsidePropertyBlock = true;
                }
            } else if (!msg.property_group_id && isInsidePropertyBlock) {
                finalHTML += '</div>';
                isInsidePropertyBlock = false;
            }
            lastGroupId = msg.property_group_id;

            const isFirstInGroup = (msg.sender_id !== lastSender) || (parseInt(msg.timestamp) - lastTimestamp > 300);
            
            if (isFirstInGroup) {
                if (i !== 0) finalHTML += '</div>'; // Ferme le précédent message-group
                finalHTML += '<div class="message-group">';
            }

            // Détermination des classes spéciales pour la bulle
            let bubbleClasses = [];
            if (msg.property_group_id === 'noise') bubbleClasses.push('noise');
            else if (msg.property_group_id) bubbleClasses.push('grouped');

            // Checkbox for RECEIVED messages (not from me)
            const showCheckbox = !msg.is_from_me;
            const isChecked = selectedMessageIds.includes(msg.id);
            const checkboxHTML = showCheckbox ? `
                <div class="message-checkbox-container">
                    <input type="checkbox" class="msg-checkbox" ${isChecked ? 'checked' : ''} onchange="toggleMessageSelection(${msg.id})">
            ` : '';

            // Render message bubble
            let messageDivHTML = `
                <div class="message ${msg.is_from_me ? 'out' : 'in'} ${isFirstInGroup ? 'first' : ''} ${bubbleClasses.join(' ')}" style="width:fit-content; max-width: 320px;">
                    ${!msg.is_from_me && isFirstInGroup ? `<div class="sender-name" style="color:${getRandomColor(msg.sender_name || 'Inconnu')}">${msg.sender_name || 'Inconnu'}</div>` : ''}
                    <div class="message-content">
            `;

            if (msg.has_media && msg.media_path) {
                const mediaUrl = '/' + msg.media_path.replace('./', '');
                if (msg.media_mime_type?.startsWith('image/')) {
                    messageDivHTML += `<img src="${mediaUrl}" class="media-item large">`;
                } else if (msg.media_mime_type?.startsWith('video/')) {
                    messageDivHTML += `<video src="${mediaUrl}" controls class="media-item large"></video>`;
                } else if (msg.media_mime_type?.startsWith('audio/')) {
                    messageDivHTML += `<audio src="${mediaUrl}" controls style="width:200px; height:35px;"></audio>`;
                }
            }

            if (msg.body) {
                messageDivHTML += `<div style="font-size: 14.2px;">${msg.body.replace(/\n/g, '<br>')}</div>`;
            }

            messageDivHTML += `
                    </div>
                    <div class="message-footer"><span class="timestamp">${dateStr}</span></div>
                </div>
            `;

            finalHTML += showCheckbox ? `${checkboxHTML}${messageDivHTML}</div>` : messageDivHTML;

            lastSender = msg.sender_id;
            lastTimestamp = parseInt(msg.timestamp);
        }

        finalHTML += '</div>' + (isInsidePropertyBlock ? '</div>' : '');
        
        // Gestion intelligente du scroll
        const isAtBottom = msgsEl.scrollHeight - msgsEl.scrollTop <= msgsEl.clientHeight + 100;
        
        // Anti-clignotement conversation
        if (lastMessagesHTML !== finalHTML) {
            lastMessagesHTML = finalHTML;
            msgsEl.innerHTML = finalHTML;
            
            // On ne scrolle que si l'utilisateur était déjà en bas ou si c'est le premier chargement
            if (isAtBottom || !msgsEl.dataset.initialized) {
                msgsEl.scrollTop = msgsEl.scrollHeight;
                msgsEl.dataset.initialized = 'true';
            }
        }

    } catch (e) {
        console.error("Erreur chargement messages:", e);
    }
}

function toggleMessageSelection(id) {
    const index = selectedMessageIds.indexOf(id);
    if (index === -1) {
        selectedMessageIds.push(id);
    } else {
        selectedMessageIds.splice(index, 1);
    }
    updateActionBar();
}

function updateActionBar() {
    const bar = document.getElementById('manualActionBar');
    const count = document.getElementById('selectedCount');
    if (selectedMessageIds.length > 0) {
        bar.style.display = 'flex';
        count.textContent = selectedMessageIds.length;
    } else {
        bar.style.display = 'none';
    }
}

async function handleManualAction(action) {
    if (selectedMessageIds.length === 0) return;
    
    try {
        const res = await fetch('/api/messages/manual-group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messageIds: selectedMessageIds,
                action: action
            })
        });
        
        const data = await res.json();
        if (data.success) {
            selectedMessageIds = [];
            updateActionBar();
            await loadMessages(currentChatId);
        } else {
            alert(data.error || "Erreur lors de l'action");
        }
    } catch (e) {
        console.error("Manual action failed:", e);
    }
}

function clearSelection() {
    selectedMessageIds = [];
    updateActionBar();
    // Refresh checkboxes visually
    document.querySelectorAll('.msg-checkbox').forEach(cb => cb.checked = false);
}

// Polling and init
function startMessagesPolling(id) {
    if (messagesInterval) clearInterval(messagesInterval);
    messagesInterval = setInterval(() => {
        if (currentChatId === id) loadMessages(id);
    }, 2000);
}

loadChats();
setInterval(loadChats, 4000);

// Globalize functions for HTML onclick
window.selectChat = selectChat;
window.toggleMessageSelection = toggleMessageSelection;
window.handleManualAction = handleManualAction;
window.clearSelection = clearSelection;
