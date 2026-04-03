require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

// --- SETUP SERVEUR WEB (Frontend & API) ---
const app = express();
app.use(cors());
app.use(express.json()); // Support pour le JSON dans les requêtes POST
app.use(express.static(path.join(__dirname, 'frontend-dist')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(__dirname, 'media')));

// Fallback SPA : renvoie index.html de React pour toute route non-API
app.get(/^\/(?!api).*/, (req, res) => {
    const indexPath = path.join(__dirname, 'frontend-dist', 'index.html');
    const fs = require('fs');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        // Fallback si React n'est pas buildé (dev local)
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

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
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS real_property_id INTEGER;');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(255);');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS district VARCHAR(255);');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS municipality VARCHAR(255);');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS analysis_error TEXT;');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMP;');
            await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS ia_property_id VARCHAR(255);');

            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_chat_id_ts ON messages(chat_id, timestamp DESC);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_is_analyzed ON messages(is_analyzed);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_property_group_id ON messages(property_group_id);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_real_property_id ON messages(real_property_id);');

            // Optimisation Recherche (GIN Index pour ILIKE rapide)
            await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_body_trgm ON messages USING GIN (body gin_trgm_ops);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);');

            // -- ROUTES API EXPRESS (Déclarées ici car on a besoin de db prêt) --
            // --- FONCTION D'EXTRACTION IA MISTRAL ---
            async function extractPropertyDataWithAI(description) {
                const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
                const MISTRAL_MODEL = process.env.AI_MODEL || 'mistral-medium-latest';

                if (!MISTRAL_API_KEY) {
                    console.error("❌ MISTRAL_API_KEY manquante dans le .env du Bot");
                    return null;
                }

                const prompt = `
Tu es un extracteur de données immobilières pour WhatsApp. Analyse la description suivante et extrait les informations selon les champs spécifiés (JSON uniquement).

⚠️ RÈGLE CRITIQUE: Retourne UNIQUEMENT les champs mentionnés explicitement dans la description. NE JAMAIS INVENTER d'informations.

📚 EXEMPLES CONCRETS D'EXTRACTION :
Exemple 1: "Chambre salon à Calavi Tokan, loyer 25000" -> {"type": "APARTMENT", "rent_price": 25000, "localisation": "Calavi Tokan", "number_rooms": 1, "number_living_rooms": 1, "sanitary": "YES"}
Exemple 2: "Entrée couchée à Maria Gleta, loyer 20000" -> {"type": "STUDIO", "rent_price": 20000, "localisation": "Maria Gleta", "number_rooms": 0, "number_living_rooms": 1, "sanitary": "YES"}
Exemple 3: "Magasin à louer à Godomey, loyer 50000" -> {"type": "STORE", "rent_price": 50000, "localisation": "Godomey", "number_rooms": 1, "number_living_rooms": 0, "sanitary": "YES"}
Exemple 4: "Boutique disponible à Cotonou centre, 35000 FCFA" -> {"type": "STORE", "rent_price": 35000, "localisation": "Cotonou centre", "number_rooms": 1, "number_living_rooms": 0, "sanitary": "YES"}

⚠️ RÈGLE SPÉCIALE MAGASINS/BOUTIQUES :
Pour les types STORE, SHOP, OFFICE (magasins, boutiques, bureaux) : TOUJOURS mettre "number_rooms": 1 et "number_living_rooms": 0 par défaut.

🎯 CHAMPS À EXTRAIRE (SI MENTIONNÉS) :
- "type": "HOUSE|APARTMENT|STUDIO|VILLA|SHOP|STORE|PARCEL|OFFICE|BUILDING"
- "to_sell": false (On accepte que les locations)
- "rent_price": nombre (prix en FCFA)
- "visit_price": nombre (prix de visite en FCFA, défaut: 2000)
- "commission": nombre (commission agence)
- "description": la description originale complète
- "localisation": (Quartier et points de repère). EXTRÊMEMENT IMPORTANT : Extrais le lieu exact (ex: "Calavi Tokan", "Fidjrossè", "Akpakpa").
- "number_living_rooms": nombre de salons
- "number_rooms": nombre de chambres (Pour STUDIO/ENTRÉE COUCHÉE, c'est 0 chambre)
- "tarification": "MONTHLY|DAILY"
- "sanitary": "YES" (sanitaire) ou "NO" (ordinaire)
- "caution": nombre (caution en FCFA)
- "month_advance": nombre (mois d'avance)

Texte à analyser : "${description}"
`;


                try {
                    const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
                        model: MISTRAL_MODEL,
                        messages: [
                            { role: 'system', content: 'Tu es un expert en analyse immobilière. Réponds uniquement en JSON valide sans bloc markdown.' },
                            { role: 'user', content: prompt }
                        ],
                        response_format: { type: 'json_object' }
                    }, {
                        headers: {
                            'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 45000 // 45s de timeout pour l'IA
                    });

                    const content = response.data.choices[0].message.content.trim();
                    return JSON.parse(content);
                } catch (error) {
                    console.error("❌ Erreur Mistral AI dans le Bot:", error.message);
                    return null;
                }
            }

            // 🤖 FONCTION DE BALAYAGE AUTO (HEURISTIQUE)
            const runAutoGroupHeuristicAllChats = async () => {
                try {
                    const { rows: chats } = await db.query("SELECT DISTINCT chat_id FROM messages");
                    console.log(`🧹 Balayage heuristique sur ${chats.length} conversations...`);
                    for (let chat of chats) {
                        await internalAnalyzeChat(chat.chat_id);
                    }
                } catch (e) { console.error("❌ Error runAutoGroupHeuristicAllChats:", e); }
            };

            const internalAnalyzeChat = async (chatId) => {
                // 1. On commence par NETTOYER tous les anciens groupements automatiques (non validés) 
                // pour ce chat, afin de repartir sur une base saine.
                await db.query(
                    "UPDATE messages SET property_group_id = NULL WHERE chat_id = $1 AND property_group_id LIKE 'auto_prop_%' AND real_property_id IS NULL",
                    [chatId]
                );

                // 2. On récupère les messages triés strictement
                const { rows: msgs } = await db.query(
                    "SELECT id, body, has_media, media_mime_type, property_group_id, sender_id, timestamp, real_property_id FROM messages WHERE chat_id = $1 ORDER BY timestamp ASC, id ASC",
                    [chatId]
                );
                
                let parentMsgBySender = {};      
                let inGroupingModeBySender = {}; 
                let groupsFound = 0;

                for (let msg of msgs) {
                    const sender = msg.sender_id;

                    // Condition 1: Texte long TOUT SEUL (Parent)
                    if (msg.body && msg.body.length > 100 && !msg.has_media) {
                        parentMsgBySender[sender] = msg;
                        inGroupingModeBySender[sender] = true;  
                    }
                    // Condition 2: IMAGE ou VIDÉO uniquement arrivant APRÈS un parent valide
                    else if (msg.has_media && (msg.media_mime_type?.startsWith('image/') || msg.media_mime_type?.startsWith('video/')) && inGroupingModeBySender[sender] && (!msg.body || msg.body.length < 40)) {
                        const parent = parentMsgBySender[sender];
                        const timeDiff = msg.timestamp - parent.timestamp;
                        
                        if (parent && timeDiff >= 0 && timeDiff < 420 && !parent.real_property_id && !msg.real_property_id) {
                            const groupId = parent.property_group_id || `auto_prop_parent_${parent.id}`;
                            await db.query("UPDATE messages SET property_group_id = $1 WHERE id IN ($2, $3)", [groupId, parent.id, msg.id]);
                            parent.property_group_id = groupId;
                            msg.property_group_id = groupId;
                            groupsFound++;
                        } else {
                            inGroupingModeBySender[sender] = false;
                            parentMsgBySender[sender] = null;
                        }
                    }
                    // Condition 3: Tout autre message (texte court, ou média avec gros texte) CASSE la chaîne
                    else {
                        inGroupingModeBySender[sender] = false;
                        parentMsgBySender[sender] = null;
                    }
                }
                return groupsFound;
            };

            // 🤖 ANALYSE AUTO (HEURISTIQUE) SUR TOUT LE CHAT
            app.post('/api/messages/analyze-chat/:chatId', async (req, res) => {
                try {
                    const groupsFound = await internalAnalyzeChat(req.params.chatId);
                    res.json({ success: true, message: `Analyse heuristique terminée. ${groupsFound} associations effectuées.` });
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // Exposer pour usage dans ready
            app.set('runAutoGroupHeuristicAllChats', runAutoGroupHeuristicAllChats);


            app.get('/api/chats', async (req, res) => {
                try {
                    // Calculer le nombre de messages non traités (is_analyzed = false) pour chaque groupe
                    const query = `
                        WITH chat_msgs AS (
                            SELECT m.id, m.chat_id, m.body, m.has_media, m.message_type, m.is_analyzed, m.is_from_me, m.property_group_id
                            FROM messages m
                            JOIN chats c ON m.chat_id = c.whatsapp_chat_id
                            WHERE c.whatsapp_chat_id != 'status@broadcast'
                        ),
                        banned_groups AS (
                            SELECT DISTINCT property_group_id 
                            FROM chat_msgs 
                            WHERE body ~* 'vendre|vente|parcelle|terrain|titre foncier| tf'
                            AND property_group_id IS NOT NULL
                        ),
                        chat_counts AS (
                            SELECT c.*, 
                            (SELECT COUNT(*) FROM chat_msgs m 
                             LEFT JOIN banned_groups bg ON m.property_group_id = bg.property_group_id
                             WHERE m.chat_id = c.whatsapp_chat_id 
                             AND m.is_analyzed = FALSE 
                             AND m.is_from_me = FALSE
                             AND bg.property_group_id IS NULL -- Le groupe complet n'est pas banni
                             AND (m.body IS NULL OR m.body !~* 'vendre|vente|parcelle|terrain|titre foncier| tf') -- Le message seul n'est pas banni
                             AND ( (m.body IS NOT NULL AND TRIM(m.body) != '') OR m.has_media = TRUE )
                             AND m.message_type NOT IN ('audio', 'ptt', 'sticker')
                            ) as unread_count
                            FROM chats c 
                            WHERE c.whatsapp_chat_id != 'status@broadcast'
                        )
                        SELECT * FROM chat_counts 
                        WHERE unread_count > 0
                        ORDER BY updated_at DESC
                    `;
                    const { rows } = await db.query(query);
                    res.json(rows);
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            app.get('/api/messages/:chatId', async (req, res) => {
                try {
                    const { before, limit = 30 } = req.query;
                    const safeLimit = Math.min(parseInt(limit) || 30, 100);

                    let query, params;
                    // Construction d'un CTE pour pré-filtrer et identifier les "sandwichs" de texte
                    const cteBase = `
                        WITH raw_msgs AS (
                            SELECT id, message_id, body, timestamp, is_from_me, is_group, chat_id, sender_id, sender_name, has_media, media_path, media_mime_type, property_group_id, real_property_id, neighborhood, district, municipality, analysis_error, ia_property_id, message_type, is_analyzed, analyzed_at
                            FROM messages 
                            WHERE chat_id = $1
                        ),
                        banned_groups AS (
                            SELECT DISTINCT property_group_id 
                            FROM raw_msgs 
                            WHERE body ~* 'vendre|vente|parcelle|terrain|titre foncier| tf'
                            AND property_group_id IS NOT NULL
                        ),
                        filtered_msgs_raw AS (
                            SELECT r.* FROM raw_msgs r
                            LEFT JOIN banned_groups bg ON r.property_group_id = bg.property_group_id
                            WHERE (r.is_analyzed = FALSE OR r.analyzed_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour')
                            AND bg.property_group_id IS NULL -- Exclure TOUS les membres d'un groupe contenant 'vendre'
                            AND (r.body IS NULL OR r.body !~* 'vendre|vente|parcelle|terrain|titre foncier| tf') -- Vérif individuelle au cas où (message non groupé)
                            AND ( (r.body IS NOT NULL AND TRIM(r.body) != '') OR r.has_media = TRUE )
                            AND r.message_type NOT IN ('audio', 'ptt', 'sticker')
                        ),
                        filtered_msgs AS (
                            SELECT fm.*,
                                   LAG(has_media) OVER(ORDER BY timestamp ASC) as prev_has_media,
                                   LEAD(has_media) OVER(ORDER BY timestamp ASC) as next_has_media
                            FROM filtered_msgs_raw fm
                        )
                    `;

                    if (before) {
                        query = `
                            ${cteBase}
                            SELECT * FROM (
                                SELECT id, message_id, body, timestamp, is_from_me, is_group, chat_id, sender_id, sender_name, has_media, media_path, media_mime_type, property_group_id, real_property_id, neighborhood, district, municipality, analysis_error, ia_property_id
                                FROM filtered_msgs 
                                WHERE timestamp < $2
                                AND NOT (has_media = FALSE AND COALESCE(prev_has_media, TRUE) = FALSE AND COALESCE(next_has_media, TRUE) = FALSE)
                                ORDER BY timestamp DESC 
                                LIMIT $3
                            ) AS sub 
                            ORDER BY timestamp ASC
                        `;
                        params = [req.params.chatId, before, safeLimit];
                    } else {
                        query = `
                            ${cteBase}
                            SELECT * FROM (
                                SELECT id, message_id, body, timestamp, is_from_me, is_group, chat_id, sender_id, sender_name, has_media, media_path, media_mime_type, property_group_id, real_property_id, neighborhood, district, municipality, analysis_error, ia_property_id
                                FROM filtered_msgs 
                                WHERE NOT (has_media = FALSE AND COALESCE(prev_has_media, TRUE) = FALSE AND COALESCE(next_has_media, TRUE) = FALSE)
                                ORDER BY timestamp DESC 
                                LIMIT $2
                            ) AS sub 
                            ORDER BY timestamp ASC
                        `;
                        params = [req.params.chatId, safeLimit];
                    }
                const { rows } = await db.query(query, params);
                res.json(rows);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 🔍 Endpoint de polling spécifique aux IDs (Robuste)
        app.get('/api/messages-status', async (req, res) => {
            try {
                const ids = req.query.ids ? req.query.ids.split(',') : [];
                if (ids.length === 0) return res.json([]);
                const { rows } = await db.query(
                    'SELECT id, property_group_id, real_property_id, neighborhood, district, municipality, analysis_error, ia_property_id FROM messages WHERE id = ANY($1)',
                    [ids.map(id => parseInt(id))]
                );
                res.json(rows);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 🔎 Recherche de messages liés à des BIENS RÉELS
        app.get('/api/messages/search', async (req, res) => {
            try {
                const { q } = req.query;
                if (!q || q.length < 2) return res.json([]);

                const query = `
                    SELECT id, message_id, body, timestamp, chat_name, sender_name, real_property_id, neighborhood, district, municipality, media_path, media_mime_type, property_group_id
                    FROM messages 
                    WHERE (real_property_id IS NOT NULL OR (property_group_id IS NOT NULL AND property_group_id != 'noise'))
                    AND body @@ plainto_tsquery('french', $1)
                    ORDER BY timestamp DESC
                    LIMIT 50
                `;
                const { rows } = await db.query(query, [q]);
                res.json(rows);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 📅 Liste AGGRÉGÉE des BIENS avec FILTRE PAR DATE (Conversations confondues)
        app.get('/api/properties/all', async (req, res) => {
            try {
                const { start, end } = req.query; // Expectations: timestamp en secondes ou ISO string
                
                let dateFilter = "WHERE m.real_property_id IS NOT NULL";
                const params = [];

                if (start) {
                    params.push(parseInt(start));
                    dateFilter += ` AND m.timestamp >= $${params.length}`;
                }
                if (end) {
                    params.push(parseInt(end));
                    dateFilter += ` AND m.timestamp <= $${params.length}`;
                }

                const query = `
                    WITH property_groups AS (
                        SELECT 
                            real_property_id,
                            JSONB_AGG(
                                JSONB_BUILD_OBJECT(
                                    'id', id,
                                    'body', body,
                                    'timestamp', timestamp,
                                    'sender_name', sender_name,
                                    'has_media', has_media,
                                    'media_path', media_path,
                                    'media_mime_type', media_mime_type
                                ) ORDER BY timestamp ASC
                            ) as messages,
                            MAX(timestamp) as last_updated,
                            MIN(neighborhood) as neighborhood,
                            MIN(district) as district,
                            MIN(municipality) as municipality
                        FROM messages m
                        ${dateFilter}
                        GROUP BY real_property_id
                    )
                    SELECT * FROM property_groups
                    ORDER BY last_updated DESC
                `;
                const { rows } = await db.query(query, params);
                res.json(rows);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // ROUTE DE GROUPEMENT MANUEL + SOUMISSION À NESTJS

            app.post('/api/messages/submit-property', async (req, res) => {
                const { messageIds } = req.body;
                if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
                    return res.status(400).json({ error: 'Aucun message sélectionné.' });
                }

                try {
                    // 1. Récupérer les détails des messages depuis la BD
                    const { rows: fetchedMessages } = await db.query(
                        'SELECT * FROM messages WHERE id = ANY($1) ORDER BY timestamp ASC',
                        [messageIds]
                    );

                    if (fetchedMessages.length === 0) {
                        return res.status(404).json({ error: 'Messages introuvables.' });
                    }

                    // 2. Fusionner les textes et collecter les images EN BASE64 (évite le re-téléchargement par NestJS)
                    const texts = [];
                    const imagesBase64 = []; // Nouveau: images en base64 pour envoi direct
                    let senderPhone = "";

                    // Trouver le premier numéro d'expéditeur valide (non "me")
                    const externalMsg = fetchedMessages.find(m => !m.is_from_me);
                    if (externalMsg) {
                        // Utiliser sender_number (numéro réel) au lieu de sender_id (identifiant WhatsApp)
                        senderPhone = externalMsg.sender_number || '';
                        if (senderPhone && !senderPhone.startsWith('+')) senderPhone = '+' + senderPhone;
                    }

                    fetchedMessages.forEach(msg => {
                        if (msg.body && msg.body.trim()) {
                            texts.push(msg.body.trim());
                        }
                        const isImageOrVideo = msg.media_mime_type?.startsWith('image/') || msg.media_mime_type?.startsWith('video/');
                        if (msg.has_media && msg.media_path && isImageOrVideo) {
                            // Vérifier que le fichier existe réellement sur disque
                            const localPath = msg.media_path.startsWith('./') ? msg.media_path : `./${msg.media_path}`;
                            if (fs.existsSync(localPath)) {
                                // Lire l'image et la convertir en base64 (évite le téléchargement HTTP par NestJS)
                                try {
                                    const imageBuffer = fs.readFileSync(localPath);
                                    const base64Data = imageBuffer.toString('base64');
                                    const mimeType = msg.media_mime_type || 'image/jpeg';
                                    const ext = localPath.split('.').pop() || 'jpg';
                                    imagesBase64.push({
                                        data: base64Data,
                                        mimeType: mimeType,
                                        extension: ext
                                    });
                                } catch (readErr) {
                                    console.warn(`⚠️ Erreur lecture média: ${localPath} - ${readErr.message}`);
                                }
                            } else {
                                console.warn(`⚠️ Média manquant sur disque: ${localPath}`);
                            }
                        }
                    });

                    // 3. Fusionner le texte
                    const finalDescription = texts.join('\n\n').trim() || '(Annonce immobilière WhatsApp - Sans texte)';

                    // --- NOUVEAUX FILTRES DE SÉCURITÉ ---
                    const forbiddenKeywords = ['vendre', 'vente', 'parcelle', 'terrain', 'titre foncier', ' tf ', ' tf\n'];
                    const descriptionLower = finalDescription.toLowerCase();
                    const foundKeyword = forbiddenKeywords.find(kw => descriptionLower.includes(kw));

                    if (foundKeyword) {
                        const errMsg = `Désolé, nous n'acceptons que les locations. Ce message semble concerner une vente ou un terrain (${foundKeyword}).`;
                        console.warn(`🚫 Rejet local : Mot-clé interdit détecté : ${foundKeyword}`);
                        await db.query(`UPDATE messages SET analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        return res.status(400).json({ success: false, error: errMsg });
                    }

                    // --- VÉRIFICATION DES MÉDIAS (images ou vidéos) ---
                    if (imagesBase64.length === 0) {
                        // Compter combien de messages avaient has_media = true (image ou vidéo)
                        const mediaMessages = fetchedMessages.filter(m =>
                            m.has_media && (m.media_mime_type?.startsWith('image/') || m.media_mime_type?.startsWith('video/'))
                        );
                        let errMsg;
                        if (mediaMessages.length === 0) {
                            errMsg = "Au moins une image ou vidéo est requise. Veuillez sélectionner le(s) message(s) contenant les photos/vidéos en plus du texte.";
                        } else {
                            errMsg = `${mediaMessages.length} média(s) détecté(s) mais aucun n'est lisible. Les fichiers n'existent pas sur le serveur.`;
                        }
                        console.error(`❌ Échec de soumission: ${errMsg}`);
                        await db.query(`UPDATE messages SET analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        return res.status(400).json({ success: false, error: errMsg });
                    }

                    // 4. Analyser avec Mistral DIRECTEMENT depuis le Bot (Gain de temps et évite les timeouts Backend)
                    // On répond 202 immédiatement pour libérer le frontend
                    res.status(202).json({ success: true, message: 'Analyse IA et création en cours...' });

                    // Traitement asynchrone : IA Mistral puis NestJS
                    (async () => {
                        console.log(`🤖 Analyse Mistral en cours pour ${texts.length} messages...`);
                        const extractedData = await extractPropertyDataWithAI(finalDescription);
                        
                        if (!extractedData) {
                            const errMsg = "L'IA a échoué à analyser l'annonce. Réessayez ou vérifiez votre connexion Mistral.";
                            console.error(`❌ ${errMsg}`);
                            await db.query(`UPDATE messages SET analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                            return;
                        }

                        const nestUrl = process.env.NESTJS_API_URL || 'http://host.docker.internal:4000/properties/create-from-whatsapp';

                        console.log(`📤 Envoi à NestJS: ${imagesBase64.length} images en base64 (skip download)`);
                        axios.post(nestUrl, {
                            description: finalDescription,
                            manager_phone: senderPhone,
                            images_base64: imagesBase64, // Images en base64 (évite le téléchargement HTTP)
                            user_id: process.env.LOCAPAY_BOT_USER_ID || 1,
                            extracted_data: extractedData // On passe les données analysées !
                        }, {
                            timeout: 60000, // 60s timeout pour l'envoi base64
                            maxContentLength: 50 * 1024 * 1024, // 50MB max
                            maxBodyLength: 50 * 1024 * 1024
                        }).then(async (response) => {
                        const raw = response.data;
                        // 🔍 LOG de la réponse brute pour diagnostic
                        console.log(`📡 Réponse NestJS brute:`, JSON.stringify(raw).substring(0, 300));

                        // NestJS peut envelopper la réponse via un intercepteur global : { data: {...} }
                        // On gère les deux formats
                        const nestData = raw?.data || raw;

                        if (nestData.success) {
                            const property_id = nestData.property_id || nestData.propertyId;
                            const { location } = nestData;
                            await db.query(
                                `UPDATE messages SET property_group_id = $1, real_property_id = $2, neighborhood = $3, district = $4, municipality = $5, is_analyzed = TRUE, analyzed_at = CURRENT_TIMESTAMP, analysis_error = NULL WHERE id = ANY($6)`,
                                [`real_prop_${property_id}`, property_id, location?.neighborhood || '', location?.district || '', location?.municipality || '', messageIds]
                            );
                            console.log(`✅ Succès NestJS : Bien #${property_id} créé.`);
                        } else {
                            // On affiche d'abord le message d'erreur principal
                            let errMsg = nestData.error || nestData.message || "Erreur de traitement";
                            
                            // On ajoute les précisions sur les champs si elles existent
                            if (nestData.missingFields && Array.isArray(nestData.missingFields) && nestData.missingFields.length > 0) {
                                const fieldsList = nestData.missingFields.map(f => f.field).join(', ');
                                errMsg += ` (${fieldsList})`;
                            }
                            
                            console.error(`❌ Échec NestJS (Métier) :`, errMsg);
                            await db.query(`UPDATE messages SET property_group_id = NULL, real_property_id = NULL, is_analyzed = FALSE, analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        }
                    }).catch(async (err) => {
                        let errMsg = "Erreur backend inconnue";
                        if (err.response) {
                            // On essaie d'extraire le message d'erreur spécifique renvoyé par Nest
                            const data = err.response.data;
                            errMsg = data.error || data.message || `Erreur ${err.response.status}`;
                        } else if (err.request) {
                            errMsg = `Serveur NestJS INJOIGNABLE sur ${nestUrl}`;
                        } else {
                            errMsg = `Erreur lors de la requête : ${err.message}`;
                        }
                        console.error(`❌ ${errMsg}`);
                        await db.query(
                            `UPDATE messages SET property_group_id = NULL, real_property_id = NULL, is_analyzed = FALSE, analysis_error = $1 WHERE id = ANY($2)`,
                            [errMsg, messageIds]
                        );
                        console.log(`↩️ Messages dégroupés suite à l'erreur.`);
                        });
                    })();

                } catch (e) {
                    console.error("❌ Submit error:", e);
                    res.status(500).json({ error: e.message });
                }
            });

            // ROUTE DE GROUPEMENT MANUEL (BRUIT SEULEMENT MAINTENANT)
            app.post('/api/messages/manual-group', async (req, res) => {
                const { messageIds, action } = req.body;
                if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
                    return res.status(400).json({ error: 'Aucun message sélectionné.' });
                }

                try {
                    if (action === 'noise') {
                        await db.query('UPDATE messages SET is_analyzed = TRUE, analyzed_at = CURRENT_TIMESTAMP, property_group_id = \'noise\' WHERE id = ANY($1)', [messageIds]);
                        res.json({ success: true, message: 'Messages marqués comme bruit.' });
                    } else {
                        res.status(400).json({ error: 'Action invalide via cet endpoint.' });
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

            // ROUTE POUR ENVOYER UN MESSAGE TEXTE
            app.post('/api/send-message', async (req, res) => {
                try {
                    const { phoneNumber, message } = req.body;
                    
                    if (!phoneNumber || !message) {
                        return res.status(400).json({ error: "Les champs phoneNumber et message sont requis." });
                    }

                    let currentState = botStatus;
                    try {
                        if (client) {
                            currentState = await client.getState();
                        }
                    } catch (e) {
                        currentState = 'ERROR_GETTING_STATE';
                    }

                    if (currentState !== 'CONNECTED' && botStatus !== 'CONNECTED') {
                        return res.status(503).json({ 
                            error: "Le bot WhatsApp n'est pas connecté.", 
                            details: `Statut variable: ${botStatus}, Statut client: ${currentState}` 
                        });
                    }

                    // Nettoyage : retirer le '+' initial s'il est présent
                    const cleanNumber = phoneNumber.toString().replace(/^\\+/, '');
                    
                    // Format de l'ID WhatsApp requis par la librairie
                    const chatId = `${cleanNumber}@c.us`;

                    // Envoi du message via client (whatsapp-web.js)
                    const response = await client.sendMessage(chatId, message);
                    
                    res.json({ 
                        success: true, 
                        message: "Message envoyé avec succès.",
                        messageId: response.id._serialized 

                    });
                } catch (error) {
                    console.error("❌ Erreur lors de l\\'envoi du message :", error);
                    res.status(500).json({ error: error.message });
                }
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
    headless: true,
    bypassCSP: true,  // ← FIX: empêche WhatsApp de rediriger pendant l'injection
    protocolTimeout: 60000, // ⏳ Augmentation du timeout (60s) pour les VPS lents
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--no-first-run',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-site-isolation-trials'
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
    puppeteer: {
        ...puppeteerOptions,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
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

    // ✅ ACTIVÉ : Balayage automatique périodique (Heuristique Stricte)
    console.log('🤖 Activation du balayage automatique (Règle 100 caractères)...');
    const runAll = app.get('runAutoGroupHeuristicAllChats');
    if (runAll) {
        runAll().catch(e => console.error("❌ Error initial runAll:", e));
        setInterval(() => {
            runAll().catch(err => console.error("❌ Erreur balayage automatique:", err));
        }, 10 * 60 * 1000);
    }
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

        if (messageData.chatId === 'status@broadcast') return;

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
            ON CONFLICT (message_id) DO UPDATE SET message_id = EXCLUDED.message_id RETURNING id;
        `;

        const values = [
            messageData.messageId, messageData.body, messageData.timestamp, messageData.isFromMe,
            messageData.isGroup, messageData.chatId, messageData.chatName, messageData.senderId,
            messageData.senderName, messageData.senderNumber, messageData.receiverId,
            messageData.hasMedia, messageData.messageType, messageData.deviceType,
            messageData.mediaPath, messageData.mediaMimeType, messageData.rawData
        ];

        const resInsert = await db.query(query, values);
        const currId = resInsert.rows[0]?.id;
        console.log(`💾 Message archivé dans PostgreSQL avec succès (ID: ${currId}) ! ✅`);

        // 🤖 HEURISTIQUE DE GROUPEMENT AUTOMATIQUE (Simplification demandée par le USER)
        // Règle : Si un texte > 100 chars (SANS média) est suivi par un média du même expéditeur, on groupe.
        // ✅ ACTIVÉ : Auto-groupement en temps réel
        if (messageData.hasMedia && !messageData.isFromMe) {
            try {
                const prevMsgQuery = `
                    SELECT id, body, property_group_id, timestamp, has_media, real_property_id
                    FROM messages
                    WHERE chat_id = $1 AND sender_id = $2 AND id < $3
                    ORDER BY timestamp DESC, id DESC LIMIT 1
                `;
                const { rows: prevRows } = await db.query(prevMsgQuery, [messageData.chatId, messageData.senderId, currId]);

                if (prevRows.length > 0) {
                    const prevMsg = prevRows[0];
                    const timeDiff = messageData.timestamp - prevMsg.timestamp;

                    if (currId) {

                        // Parent : Texte long seul
                        const prevIsStrictParent = prevMsg.body && prevMsg.body.length > 100 && !prevMsg.has_media;
                        // Enfant : IMAGE ou VIDÉO seule (ou légende minuscule)
                        const currIsStrictChild = messageData.hasMedia && (messageData.mediaMimeType?.startsWith('image/') || messageData.mediaMimeType?.startsWith('video/')) && (!messageData.body || messageData.body.length < 40);

                        if (currIsStrictChild && prevIsStrictParent && timeDiff < 420 && !prevMsg.real_property_id) {
                            const groupId = prevMsg.property_group_id || `auto_prop_parent_${prevMsg.id}`;
                            await db.query("UPDATE messages SET property_group_id = $1 WHERE id IN ($2, $3)", [groupId, prevMsg.id, currId]);
                            console.log(`📎 Heuristique ULTRA-STRICTE : ${groupId}`);
                        }
                        else if (messageData.hasMedia && (messageData.mediaMimeType?.startsWith('image/') || messageData.mediaMimeType?.startsWith('video/')) && prevMsg.property_group_id && prevMsg.property_group_id.startsWith('auto_prop_parent_') && timeDiff < 420 && !prevMsg.real_property_id) {
                            // Extension d'un groupe existant (pour les albums)
                            // On vérifie aussi que ce média n'a pas une description trop longue pour être un "enfant"
                            if (!messageData.body || messageData.body.length < 40) {
                                await db.query("UPDATE messages SET property_group_id = $1 WHERE id = $2", [prevMsg.property_group_id, currId]);
                                console.log(`📎 Extension Heuristique ULTRA-STRICTE : ${currId}`);
                            }
                        }
                    }
                }
            } catch (groupErr) {
                console.error("❌ Erreur auto-groupement:", groupErr);
            }
        }

    } catch (error) {
        console.error("❌ Erreur lors de l'extraction du message :", error);
    }
});

client.initialize();
