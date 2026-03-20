const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');
const path = require('path');

// --- SETUP SERVEUR WEB (Frontend & API) ---
const app = express();
app.use(cors());
app.use(express.json()); // Support pour le JSON dans les requêtes POST
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(__dirname, 'media')));

// État global du bot pour le frontend
let botStatus = 'LOADING'; // LOADING, QR, CONNECTED, DISCONNECTED
let currentQR = null;

app.listen(3000, () => {
    console.log('✅ Frontend et API Web disponibles sur http://localhost:3000');
});
// ------------------------------------------

// Connexion à PostgreSQL
const db = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password123@db:5432/whatsapp_logs'
});

// PostgreSQL met quelques secondes à démarrer dans Docker. 
// Nous ajoutons une boucle de réessais (5 tentatives) pour patienter au lieu de crasher
async function connectToDbWithRetry(retries = 5, delay = 4000) {
    for (let i = 0; i < retries; i++) {
        try {
            await db.query('SELECT 1'); // Vérifie l'état de la connexion
            console.log('✅ Connecté avec succès à PostgreSQL !');
            
            // Création automatique de la base 'chats' (Sert de tableau de bord / liste des conversations)
            await db.query(`
                CREATE TABLE IF NOT EXISTS chats (
                    id SERIAL PRIMARY KEY,
                    whatsapp_chat_id VARCHAR(255) UNIQUE NOT NULL,
                    chat_name VARCHAR(255),
                    is_group BOOLEAN,
                    last_message_timestamp BIGINT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            console.log('✅ Table "chats" prête dans PostgreSQL.');
            
            // Création automatique de la table "messages" si elle n'existe pas
            await db.query(`
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    message_id VARCHAR(255) UNIQUE NOT NULL,
                    body TEXT,
                    timestamp BIGINT,
                    is_from_me BOOLEAN,
                    is_group BOOLEAN,
                    chat_id VARCHAR(255),
                    chat_name VARCHAR(255),
                    sender_id VARCHAR(255),
                    sender_name VARCHAR(255),
                    sender_number VARCHAR(255),
                    receiver_id VARCHAR(255),
                    has_media BOOLEAN,
                    message_type VARCHAR(100),
                    device_type VARCHAR(100),
                    media_path TEXT,
                    media_mime_type TEXT,
                    raw_data JSONB,
                    is_analyzed BOOLEAN DEFAULT FALSE,
                    property_group_id VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            console.log('✅ Table "messages" prête dans PostgreSQL.');
            
            // On s'assure d'ajouter de nouvelles colonnes si elles n'existent pas encore (pour les tables existantes)
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_path TEXT;');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime_type TEXT;');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_data JSONB;');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_analyzed BOOLEAN DEFAULT FALSE;');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS property_group_id VARCHAR(255);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_chat_id_ts ON messages(chat_id, timestamp DESC);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_is_analyzed ON messages(is_analyzed);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_property_group_id ON messages(property_group_id);');

            // -- ROUTES API EXPRESS (Déclarées ici car on a besoin de db prêt) --
            app.get('/api/chats', async (req, res) => {
                try {
                    const { rows } = await db.query('SELECT * FROM chats ORDER BY updated_at DESC');
                    res.json(rows);
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            app.get('/api/messages/:chatId', async (req, res) => {
                try {
                    // Optimisation: On ne sélectionne QUE les colonnes nécessaires (on évite raw_data qui est énorme)
                    // Limite aux 120 derniers messages pour plus de rapidité tout en gardant assez d'historique
                    const query = `
                        SELECT * FROM (
                            SELECT id, message_id, body, timestamp, is_from_me, is_group, chat_id, sender_id, sender_name, has_media, media_path, media_mime_type, property_group_id
                            FROM messages 
                            WHERE chat_id = $1 
                            ORDER BY timestamp DESC 
                            LIMIT 120
                        ) AS sub 
                        ORDER BY timestamp ASC
                    `;
                    const { rows } = await db.query(query, [req.params.chatId]);
                    res.json(rows);
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // ROUTE DE GROUPEMENT MANUEL
            app.post('/api/messages/manual-group', async (req, res) => {
                const { messageIds, action } = req.body;
                if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
                    return res.status(400).json({ error: 'Aucun message sélectionné.' });
                }

                try {
                    if (action === 'noise') {
                        await db.query('UPDATE messages SET is_analyzed = TRUE, property_group_id = \'noise\' WHERE id = ANY($1)', [messageIds]);
                        res.json({ success: true, message: 'Messages marqués comme bruit.' });
                    } else if (action === 'group') {
                        const groupId = `manual_${Date.now()}`;
                        await db.query('UPDATE messages SET is_analyzed = TRUE, property_group_id = $1 WHERE id = ANY($2)', [groupId, messageIds]);
                        res.json({ success: true, message: 'Messages regroupés avec succès.', property_group_id: groupId });
                    } else {
                        res.status(400).json({ error: 'Action invalide.' });
                    }
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // -- ROUTES STATUS BOT --
            app.get('/api/status', (req, res) => {
                res.json({ status: botStatus });
            });

            app.get('/api/qr', (req, res) => {
                res.json({ qr: currentQR });
            });
            
            return;
        } catch (err) {
            console.log(`⚠️ En attente de PostgreSQL... Postgres est peut-être en train de démarrer (tentative ${i + 1}/${retries}).`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
    console.error('❌ Impossible de se connecter à PostgreSQL. L\'erreur ECONNREFUSED persiste.');
}
connectToDbWithRetry();

const puppeteerOptions = {
    args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
    ]
};

if (process.env.CHROME_BIN) {
    puppeteerOptions.executablePath = process.env.CHROME_BIN;
} else if (process.platform === 'darwin') {
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(chromePath)) {
        puppeteerOptions.executablePath = chromePath;
    }
}

const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-js/main/dist/wppconnect-wa.js',
    },
    puppeteer: puppeteerOptions
});

client.on('qr', (qr) => {
    // Generate and display in terminal too
    qrcode.generate(qr, { small: true });
    console.log('NOUVEAU QR CODE : Scannez ce QR avec votre application WhatsApp.');
    
    // Save for UI
    botStatus = 'QR';
    currentQR = qr;
});

client.on('ready', () => {
    console.log('✅ C\'est connecté ! Le client est prêt et écoute les messages !');
    botStatus = 'CONNECTED';
    currentQR = null;

    // Démarrer la segmentation automatique toutes les 5 minutes
    console.log('🤖 Activation de la segmentation IA automatique...');
    const { runSegmentation } = require('./segmenter');
    setInterval(() => {
        runSegmentation().catch(err => console.error("❌ Erreur segmentation automatique:", err));
    }, 5 * 60 * 1000); // 5 minutes
});

client.on('authenticated', () => {
    console.log('Authentification réussie, la connexion/session a été persistée automatiquement.');
    botStatus = 'CONNECTED';
});

client.on('auth_failure', () => {
    console.error('❌ Échec de l\'authentification !');
    botStatus = 'QR';
});

client.on('disconnected', () => {
    console.log('Bot déconnecté.');
    botStatus = 'DISCONNECTED';
});

client.on('message_create', async msg => {
    try {
        let chat = null;
        let contact = null;
        try {
            chat = await msg.getChat();
            contact = await msg.getContact();
        } catch (e) {
            console.log(`⚠️ Impossible de parser l'objet Chat ou Contact (très probablement un message de "Chaîne/Newsletter" WhatsApp). Extraction en mode dégradé.`);
        }

        // Téléchargement des médias associés au message s'il y en a un
        let savedMediaPath = null;
        let savedMediaMimeType = null;

        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media) {
                    const ext = media.mimetype.split('/')[1]?.split(';')[0] || 'bin';
                    const filename = `media_${msg.id.id}_${msg.timestamp}.${ext}`;
                    const dirPath = './media';
                    
                    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
                    
                    savedMediaPath = `${dirPath}/${filename}`;
                    savedMediaMimeType = media.mimetype;
                    
                    fs.writeFileSync(savedMediaPath, Buffer.from(media.data, 'base64'));
                    console.log(`📸 Média sauvegardé avec succès: ${savedMediaPath}`);
                }
            } catch (err) {
                console.error("❌ Impossible de télécharger le média:", err);
            }
        }

        const messageData = {
            messageId: msg.id._serialized,
            body: msg.body,
            timestamp: msg.timestamp,
            isFromMe: msg.fromMe,
            isGroup: chat ? chat.isGroup : false,
            chatId: chat ? chat.id._serialized : (msg.fromMe ? msg.to : msg.from),
            chatName: chat ? chat.name : "Chaîne/Inconnu",
            senderId: msg.author || msg.from,
            senderName: contact ? (contact.name || contact.pushname || "Inconnu") : "Chaîne/Inconnu",
            senderNumber: contact ? contact.number : msg.from.split('@')[0],
            receiverId: msg.to,
            hasMedia: msg.hasMedia,
            mediaPath: savedMediaPath,
            mediaMimeType: savedMediaMimeType,
            messageType: msg.type,
            deviceType: msg.deviceType,
            rawData: msg._data || msg.rawData || {}
        };

        // 4. Création ou Mise à jour de la liste de conversation ('chats') 
        // Ainsi l'application web finale n'a pas à fouiller dans 100 000 messages pour faire un menu
        const chatQuery = `
            INSERT INTO chats (whatsapp_chat_id, chat_name, is_group, last_message_timestamp)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (whatsapp_chat_id) 
            DO UPDATE SET 
                chat_name = EXCLUDED.chat_name,
                last_message_timestamp = EXCLUDED.last_message_timestamp,
                updated_at = CURRENT_TIMESTAMP;
        `;
        await db.query(chatQuery, [messageData.chatId, messageData.chatName, messageData.isGroup, messageData.timestamp]);

        // 5. Insertion effective du message individuel dans 'messages'
        const query = `
            INSERT INTO messages (
                message_id, body, timestamp, is_from_me, is_group, chat_id, chat_name,
                sender_id, sender_name, sender_number, receiver_id, has_media, message_type, device_type,
                media_path, media_mime_type, raw_data
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (message_id) DO NOTHING;
        `;
        
        const values = [
            messageData.messageId, messageData.body, messageData.timestamp, messageData.isFromMe,
            messageData.isGroup, messageData.chatId, messageData.chatName, messageData.senderId,
            messageData.senderName, messageData.senderNumber, messageData.receiverId,
            messageData.hasMedia, messageData.messageType, messageData.deviceType,
            messageData.mediaPath, messageData.mediaMimeType, messageData.rawData
        ];

        await db.query(query, values);
        console.log("💾 Message archivé dans PostgreSQL avec succès ! ✅");

    } catch (error) {
        console.error("❌ Erreur lors de l'extraction du message :", error);
    }
});

client.initialize();
