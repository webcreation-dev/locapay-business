require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { Pool } = require('pg');
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');


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

// --- CONFIGURATION ALERTE MAIL ---
const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.MAIL_PORT) || 465,
    secure: true, 
    auth: {
        user: process.env.MAIL_USERNAME,
        pass: process.env.MAIL_PASSWORD,
    },
});

async function sendErrorAlert(errorContext, error) {
    console.log("📨 Tentative d'envoi d'alerte mail...");
    const recipient = 'adjilan2403@gmail.com, agossadourin@gmail.com';
    try {
        await transporter.sendMail({
            from: `"WhatsApp Bot Alert" <${process.env.MAIL_USERNAME}>`,
            to: recipient,
            subject: `⚠️ ALERTE BOT : ${errorContext}`,
            text: `Une erreur est survenue sur le bot WhatsApp.\n\nContexte : ${errorContext}\nErreur : ${error && error.message ? error.message : error}\n\nDate : ${new Date().toLocaleString()}`,
            html: `<p><strong>Une erreur est survenue sur le bot WhatsApp.</strong></p>
                   <p><strong>Contexte :</strong> ${errorContext}</p>
                   <p><strong>Erreur :</strong> ${error && error.message ? error.message : error}</p>
                   <p><em>Date : ${new Date().toLocaleString()}</em></p>`
        });
        console.log(`✅ Alerte mail envoyée avec succès à ${recipient}.`);
    } catch (mailErr) {
        console.error("❌ Échec de l'envoi du mail d'alerte :", mailErr.message);
    }
}

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
            
            // --- UTILITAIRE DE NETTOYAGE AUTO ---
            const deleteMediaFiles = async (messageIds) => {
                if (!messageIds || messageIds.length === 0) return;
                try {
                    const { rows } = await db.query('SELECT media_path FROM messages WHERE id = ANY($1) AND media_path IS NOT NULL', [messageIds]);
                    for (const row of rows) {
                        const localPath = path.resolve(__dirname, row.media_path);
                        if (fs.existsSync(localPath)) {
                            fs.unlinkSync(localPath);
                            // console.log(`🗑️ Média supprimé (auto-purge): ${row.media_path}`);
                        }
                    }
                    // On vide media_path dans la DB pour acter la suppression
                    await db.query('UPDATE messages SET media_path = NULL WHERE id = ANY($1)', [messageIds]);
                } catch (err) {
                    console.error("❌ Erreur lors de la suppression auto des médias:", err.message);
                }
            };

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
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(chat_id, is_analyzed, is_from_me) WHERE is_analyzed = FALSE AND is_from_me = FALSE;');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_property_group_id ON messages(property_group_id);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_real_property_id ON messages(real_property_id);');

            // Optimisation Recherche (GIN Index pour ILIKE rapide)
            await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_body_trgm ON messages USING GIN (body gin_trgm_ops);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);');

            // -- ROUTES API EXPRESS (Déclarées ici car on a besoin de db prêt) --

            // --- PRÉ-TRAITEMENT DES ABRÉVIATIONS DE PRIX ---
            // Normalise les abréviations locales (mil, k) avant envoi à Mistral
            // Ex: "28mil" → "28000", "1.5mil" → "1500", "50k" → "50000"
            function normalizePriceAbbreviations(text) {
                return text.replace(/(\d+)[.,]?(\d*)\s*(mil|k)\b/gi, (match, int, dec, unit) => {
                    let number = parseFloat(int + (dec ? '.' + dec : ''));
                    return String(Math.round(number * 1000));
                });
            }

            // --- NORMALISATION DES CARACTÈRES SPÉCIAUX (Bolds, Italics Unicode) ---
            function normalizeStyledText(text) {
                if (!text) return "";
                // 1. Gérer les caractères mathématiques stylisés (gras, italique, etc.)
                // On convertit les blocs Unicode 1D400-1D7FF vers les caractères A-Z, a-z, 0-9
                const result = Array.from(text).map(char => {
                    const cp = char.codePointAt(0);
                    if (cp >= 0x1D400 && cp <= 0x1D7FF) {
                        // Majuscules (Bold, Italic, Sans, etc.)
                        if (cp >= 0x1D400 && cp <= 0x1D419) return String.fromCodePoint(cp - 0x1D400 + 0x41); // Bold A
                        if (cp >= 0x1D41A && cp <= 0x1D433) return String.fromCodePoint(cp - 0x1D41A + 0x61); // Bold a
                        if (cp >= 0x1D434 && cp <= 0x1D44D) return String.fromCodePoint(cp - 0x1D434 + 0x41); // Italic A
                        if (cp >= 0x1D44E && cp <= 0x1D467) return String.fromCodePoint(cp - 0x1D44E + 0x61); // Italic a
                        if (cp >= 0x1D468 && cp <= 0x1D481) return String.fromCodePoint(cp - 0x1D468 + 0x41); // Bold Italic A
                        if (cp >= 0x1D482 && cp <= 0x1D49B) return String.fromCodePoint(cp - 0x1D482 + 0x61); // Bold Italic a
                        if (cp >= 0x1D49C && cp <= 0x1D4B5) return String.fromCodePoint(cp - 0x1D49C + 0x41); // Script A
                        // Chiffres Bold
                        if (cp >= 0x1D7CE && cp <= 0x1D7D7) return String.fromCodePoint(cp - 0x1D7CE + 0x30);
                    }
                    return char;
                }).join('');
                
                // 2. Normaliser les accents et mettre en minuscule
                return result.normalize('NFKD').replace(/[\u0300-\u036f]/g, "").toLowerCase();
            }

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

⚠️ RÈGLES CRITIQUES :
1. NE JAMAIS INVENTER d'informations. Si le prix n'est pas mentionné, retourne "rent_price": null.
2. PRIORITÉ TYPE : Si un texte mentionne un usage commercial (boutique ou magasin), ce type est PRIORITAIRE pour le champ "type" même s'il y a des chambres/salons.
3. TYPES : "Magasin" -> STORE, "Boutique" -> SHOP.

📚 EXEMPLES CONCRETS D'EXTRACTION :
Exemple 1: "Chambre salon à Calavi Tokan, loyer 25000" -> {"type": "APARTMENT", "rent_price": 25000, "localisation": "Calavi Tokan", "number_rooms": 1, "number_living_rooms": 1, "sanitary": "YES"}
Exemple 2: "Magasin à louer à Godomey, loyer 50000" -> {"type": "STORE", "rent_price": 50000, "localisation": "Godomey", "number_rooms": 1, "number_living_rooms": 0}
Exemple 3: "Boutique disponible avec 2 chambres salon à Cotonou, 35000 FCFA" -> {"type": "SHOP", "rent_price": 35000, "localisation": "Cotonou", "number_rooms": 2, "number_living_rooms": 1}
Exemple 4: "Villa à louer à Fidjrossè, 4 chambres" -> {"type": "VILLA", "rent_price": null, "localisation": "Fidjrossè", "number_rooms": 4, "number_living_rooms": 1}

🎯 CHAMPS À EXTRAIRE (SI MENTIONNÉS) :
- "type": "HOUSE|APARTMENT|STUDIO|VILLA|SHOP|STORE|PARCEL|BUILDING"
- "to_sell": false (On accepte que les locations)
- "rent_price": nombre (prix en FCFA) ou null
- "visit_price": nombre (prix de visite en FCFA, défaut: 2000)
- "commission": nombre (commission agence)
- "description": la description originale complète
- "localisation": (Quartier et points de repère). EXTRÊMEMENT IMPORTANT : Extrais le lieu exact (ex: "Calavi Tokan", "Fidjrossè", "Akpakpa").
- "number_living_rooms": nombre de salons
- "number_rooms": nombre de chambres (Pour STUDIO c'est 0 chambre)
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

            // --- FONCTION DE PURGE MASSIVE ---
            async function internalPurgeNoise() {
                try {
                    const res1 = await db.query(`
                        UPDATE messages 
                        SET property_group_id = 'noise', analysis_error = NULL
                        WHERE real_property_id IS NULL AND property_group_id IS NULL
                        AND (
                            body ~* 'vendre|vente|parcelle|terrain|vendeurs|titre\\sfoncier|\\stf\\s|\\stf\n|domaine|\\stf$|opportunite|recherche'
                            OR (LENGTH(COALESCE(body, '')) < 20)
                        )
                    `);
                    const res2 = await db.query(`
                        UPDATE messages
                        SET property_group_id = 'noise', analysis_error = NULL
                        WHERE id IN (
                            WITH msg_groups AS (
                                SELECT id, chat_id, has_media, rn,
                                    MIN(CASE WHEN has_media = TRUE THEN rn END) OVER (
                                        PARTITION BY chat_id ORDER BY rn ASC
                                        ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
                                    ) as next_media_rn
                                FROM (
                                    SELECT id, chat_id, has_media,
                                           ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY timestamp ASC, id ASC) as rn
                                    FROM messages
                                    WHERE real_property_id IS NULL AND property_group_id IS NULL
                                ) t
                            ),
                            last_text_check AS (
                                SELECT id, has_media, rn,
                                    MAX(CASE WHEN has_media = FALSE THEN rn END) OVER (
                                        PARTITION BY chat_id, next_media_rn
                                    ) as last_text_rn
                                FROM msg_groups
                                WHERE next_media_rn IS NOT NULL
                            )
                            SELECT id FROM last_text_check
                            WHERE has_media = FALSE AND rn < last_text_rn
                        )
                    `);
                    const res3 = await db.query(`
                        UPDATE messages
                        SET property_group_id = 'noise', analysis_error = NULL
                        WHERE id IN (
                            SELECT m.id
                            FROM messages m
                            WHERE m.has_media = TRUE
                            AND m.property_group_id IS NULL
                            AND m.real_property_id IS NULL
                            AND NOT EXISTS (
                                SELECT 1 FROM messages txt
                                WHERE txt.chat_id = m.chat_id
                                AND txt.has_media = FALSE
                                AND LENGTH(txt.body) > 100
                                AND txt.timestamp < m.timestamp
                                AND txt.timestamp >= m.timestamp - 600
                            )
                        )
                    `);
                    const res4 = await db.query(`
                        UPDATE messages
                        SET property_group_id = 'noise', analysis_error = NULL
                        WHERE id IN (
                            SELECT m.id
                            FROM messages m
                            WHERE m.has_media = FALSE
                            AND LENGTH(m.body) > 100
                            AND m.property_group_id IS NULL
                            AND m.real_property_id IS NULL
                            AND NOT EXISTS (
                                SELECT 1 FROM messages img
                                WHERE img.chat_id = m.chat_id
                                AND img.has_media = TRUE
                                AND img.timestamp > m.timestamp
                                AND img.timestamp <= m.timestamp + 600
                            )
                        )
                    `);
                    const totalPurged = (res1.rowCount || 0) + (res2.rowCount || 0) + (res3.rowCount || 0) + (res4.rowCount || 0);

                    // --- AUTO-PURGE : Suppression physique des fichiers marqués comme noise ---
                    if (totalPurged > 0) {
                        try {
                            const { rows } = await db.query("SELECT id FROM messages WHERE property_group_id = 'noise' AND media_path IS NOT NULL");
                            if (rows.length > 0) {
                                await deleteMediaFiles(rows.map(r => r.id));
                            }
                        } catch (purgeErr) {
                            console.error("⚠️ Erreur lors de la purge physique du bruit:", purgeErr.message);
                        }
                    }

                    return totalPurged;
                } catch (e) {
                    console.error("❌ Error internalPurgeNoise:", e);
                    throw e;
                }
            }

            // 🗑️ Grande Purge massive des messages parasites (Ventes, Courts, Orphelins)
            app.post('/api/chats/purge-noise', async (req, res) => {
                try {
                    const total = await internalPurgeNoise();
                    res.json({ success: true, message: `${total} messages nettoyés au total.` });
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

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
                // Mots interdits (ventes, terrains, recherches, etc.)
                const FORBIDDEN_REGEX = 'vendre|vente|parcelle|terrain|titre\\sfoncier|\\stf\\s|\\stf\n|domaine|\\stf$|opportunite|recherche';
                const forbiddenPattern = new RegExp(FORBIDDEN_REGEX.replace(/\\/g, '\\'), 'i');

                await db.query(
                    `UPDATE messages SET property_group_id = 'noise', analysis_error = NULL WHERE chat_id = $1 AND property_group_id IS DISTINCT FROM 'noise' AND real_property_id IS NULL AND body ~* $2`,
                    [chatId, FORBIDDEN_REGEX]
                );

                // 1.1 Marquer comme noise les messages très courts sans média (< 20 caractères)
                await db.query(
                    `UPDATE messages SET property_group_id = 'noise' WHERE chat_id = $1 AND property_group_id IS NULL AND real_property_id IS NULL AND has_media = FALSE AND LENGTH(COALESCE(body, '')) < 20`,
                    [chatId]
                );

                // 2. On commence par NETTOYER tous les anciens groupements automatiques (non validés)
                // pour ce chat, afin de repartir sur une base saine.
                await db.query(
                    "UPDATE messages SET property_group_id = NULL WHERE chat_id = $1 AND property_group_id LIKE 'auto_prop_%' AND real_property_id IS NULL",
                    [chatId]
                );

                // 3. On récupère les messages triés strictement (exclure noise et ceux déjà associés à un bien)
                const { rows: msgs } = await db.query(
                    "SELECT id, body, has_media, media_mime_type, property_group_id, sender_id, timestamp, real_property_id FROM messages WHERE chat_id = $1 AND real_property_id IS NULL AND (property_group_id IS NULL OR property_group_id NOT IN ('noise')) ORDER BY timestamp ASC, id ASC",
                    [chatId]
                );

                let parentMsgBySender = {};
                let inGroupingModeBySender = {};
                let uniqueGroups = new Set();

                for (let msg of msgs) {
                    const sender = msg.sender_id;
                    const normalizedBody = normalizeStyledText(msg.body);

                    // Skip si contient des mots interdits (double vérification après normalisation)
                    if (normalizedBody && forbiddenPattern.test(normalizedBody)) {
                        await db.query("UPDATE messages SET property_group_id = 'noise', analysis_error = NULL WHERE id = $1", [msg.id]);
                        inGroupingModeBySender[sender] = false;
                        parentMsgBySender[sender] = null;
                        continue;
                    }

                    // Condition 0: Message complet (texte > 100 chars + média image/vidéo) → groupe autonome
                    if (msg.body && msg.body.length > 100 && msg.has_media &&
                        (msg.media_mime_type?.startsWith('image/') || msg.media_mime_type?.startsWith('video/')) &&
                        !msg.real_property_id && !msg.property_group_id) {
                        const groupId = `auto_prop_self_${msg.id}`;
                        await db.query("UPDATE messages SET property_group_id = $1 WHERE id = $2", [groupId, msg.id]);
                        uniqueGroups.add(groupId);
                        continue; // Ce message est autonome, on passe au suivant
                    }

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
                            uniqueGroups.add(groupId);
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

                // NOUVELLE RÈGLE MÉTIER RADICALE : Destruction des textes isolés (sans image)
                // Si un message n'a pas reçu de groupe après 1 heure, et qu'il n'a pas d'image, c'est du bruit.
                await db.query(`
                    UPDATE messages 
                    SET property_group_id = 'noise' 
                    WHERE chat_id = $1 
                    AND property_group_id IS NULL 
                    AND real_property_id IS NULL 
                    AND has_media = FALSE 
                    AND timestamp < (EXTRACT(EPOCH FROM NOW()) - 3600)
                `, [chatId]);

                return uniqueGroups.size;
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

            // 🔄 ANALYSE AUTO SUR TOUTES LES CONVERSATIONS
            app.post('/api/chats/analyze-all', async (req, res) => {
                try {
                    const { rows: chats } = await db.query(
                        "SELECT DISTINCT whatsapp_chat_id FROM chats WHERE whatsapp_chat_id != 'status@broadcast'"
                    );

                    let totalGroups = 0;
                    for (const chat of chats) {
                        const groups = await internalAnalyzeChat(chat.whatsapp_chat_id);
                        totalGroups += groups;
                    }

                    res.json({ success: true, message: `${totalGroups} groupes détectés sur ${chats.length} conversations.` });
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // Exposer pour usage dans ready
            app.set('runAutoGroupHeuristicAllChats', runAutoGroupHeuristicAllChats);

            // 📊 API pour les groupes rejetés (exclut les mots interdits qui sont marqués noise)
            app.get('/api/rejected-groups', async (req, res) => {
                try {
                    const { rows } = await db.query(`
                        SELECT
                            m.property_group_id,
                            m.chat_id,
                            c.chat_name,
                            m.analysis_error,
                            MIN(m.timestamp) as first_message_at,
                            COUNT(*) as message_count,
                            MAX(CASE WHEN m.body IS NOT NULL AND LENGTH(m.body) > 50 THEN LEFT(m.body, 300) END) as description,
                            ARRAY_AGG(DISTINCT m.id) as message_ids
                        FROM messages m
                        LEFT JOIN chats c ON m.chat_id = c.whatsapp_chat_id
                        WHERE m.analysis_error IS NOT NULL
                        AND m.property_group_id IS NOT NULL
                        AND m.property_group_id != 'noise'
                        AND m.real_property_id IS NULL
                        AND NOT (m.body ~* 'vendre|vente|parcelle|terrain|titre\\sfoncier|\\stf\\s|\\stf\n|domaine|\\stf$|opportunite|recherche')
                        GROUP BY m.property_group_id, m.chat_id, c.chat_name, m.analysis_error
                        ORDER BY m.analysis_error, MIN(m.timestamp) DESC
                    `);

                    // Grouper par type d'erreur
                    const grouped = {};
                    for (const row of rows) {
                        const error = row.analysis_error;
                        if (!grouped[error]) {
                            grouped[error] = [];
                        }
                        grouped[error].push(row);
                    }

                    res.json({
                        total: rows.length,
                        by_error: grouped,
                        groups: rows
                    });
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // 🔄 Réinitialiser un groupe rejeté pour le retraiter
            app.post('/api/rejected-groups/:propertyGroupId/retry', async (req, res) => {
                try {
                    const { propertyGroupId } = req.params;
                    await db.query(`
                        UPDATE messages
                        SET analysis_error = NULL, submission_failed = FALSE
                        WHERE property_group_id = $1
                    `, [propertyGroupId]);
                    res.json({ success: true, message: 'Groupe réinitialisé pour retraitement' });
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // 📊 API pour les groupes EN ATTENTE (ceux qui n'ont ni erreur, ni noise, ni bien créé)
            app.get('/api/pending-groups', async (req, res) => {
                try {
                    const { rows } = await db.query(`
                        SELECT
                            m.property_group_id,
                            m.chat_id,
                            c.chat_name,
                            MIN(m.timestamp) as first_message_at,
                            COUNT(*) as message_count,
                            MAX(CASE WHEN m.body IS NOT NULL AND LENGTH(m.body) > 50 THEN LEFT(m.body, 1000) END) as description,
                            ARRAY_AGG(DISTINCT m.id) as message_ids
                        FROM messages m
                        LEFT JOIN chats c ON m.chat_id = c.whatsapp_chat_id
                        WHERE m.property_group_id IS NOT NULL 
                        AND m.property_group_id != 'noise'
                        AND m.property_group_id NOT LIKE 'real_prop_%'
                        AND m.real_property_id IS NULL
                        AND m.analysis_error IS NULL
                        -- Double sécurité : exclure les mots interdits même s'ils sont déjà groupés
                        AND NOT (m.body ~* 'vendre|vente|parcelle|terrain|titre\\sfoncier|\\stf\\s|\\stf\n|domaine|\\stf$|opportunite|recherche')
                        GROUP BY m.property_group_id, m.chat_id, c.chat_name
                        ORDER BY MIN(m.timestamp) DESC
                    `);

                    res.json({
                        total: rows.length,
                        groups: rows
                    });
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // 🗑️ Ignorer en masse par message d'erreur
            app.post('/api/rejected-groups/clear-by-error', async (req, res) => {
                const { errorLabel } = req.body;
                if (!errorLabel) return res.status(400).json({ error: "L'erreur est requise." });

                try {
                    await db.query(`
                        UPDATE messages 
                        SET property_group_id = 'noise', analysis_error = NULL, submission_failed = TRUE
                        WHERE analysis_error = $1 
                        AND real_property_id IS NULL 
                        AND property_group_id IS NOT NULL 
                        AND property_group_id != 'noise'
                    `, [errorLabel]);

                    res.json({ success: true, message: `Tous les groupes avec l'erreur "${errorLabel}" ont été ignorés.` });
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // 🗑️ Marquer un groupe rejeté comme noise (ignorer définitivement)
            app.post('/api/rejected-groups/:propertyGroupId/ignore', async (req, res) => {
                try {
                    const { propertyGroupId } = req.params;
                    await db.query(`
                        UPDATE messages
                        SET property_group_id = 'noise'
                        WHERE property_group_id = $1
                    `, [propertyGroupId]);
                    res.json({ success: true, message: 'Groupe ignoré définitivement' });
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            app.get('/api/chats', async (req, res) => {
                try {
                    // Compte UNIQUEMENT les messages "bruts" qui n'ont pas encore été catégorisés ou groupés
                    const query = `
                        WITH banned_groups AS (
                            SELECT DISTINCT property_group_id
                            FROM messages
                            WHERE body ~* 'vendre|vente|parcelle|terrain|titre foncier| tf|domaine'
                            AND property_group_id IS NOT NULL
                        ),
                        valid_pending_msgs AS (
                            SELECT m.chat_id
                            FROM messages m
                            LEFT JOIN banned_groups bg ON m.property_group_id = bg.property_group_id
                            WHERE m.real_property_id IS NULL
                            AND m.property_group_id IS NULL -- Ne jamais compter ceux assignés à un groupe
                            AND m.is_analyzed = FALSE
                            AND m.is_from_me = FALSE
                            AND bg.property_group_id IS NULL -- Exclure les membres d'un groupe interdit
                            AND COALESCE(m.message_type, '') NOT IN ('audio', 'ptt', 'sticker')
                            AND (m.body IS NULL OR m.body !~* 'vendre|vente|parcelle|terrain|titre foncier| tf|domaine')
                            AND ((m.body IS NOT NULL AND LENGTH(TRIM(m.body)) >= 20) OR m.has_media = TRUE)
                        ),
                        pending_counts AS (
                            SELECT chat_id, COUNT(*) as unread_count
                            FROM valid_pending_msgs
                            GROUP BY chat_id
                        )
                        SELECT c.*, COALESCE(p.unread_count, 0) as unread_count
                        FROM chats c
                        INNER JOIN pending_counts p ON c.whatsapp_chat_id = p.chat_id
                        WHERE c.whatsapp_chat_id != 'status@broadcast'
                        ORDER BY c.updated_at DESC
                    `;
                    const { rows } = await db.query(query);
                    res.json(rows);
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // 📝 RÉCUPÉRER LA LISTE DES CHATS (Groupes en tête)
            app.get('/api/chats/groups-list', async (req, res) => {
                try {
                    const query = `
                        SELECT 
                            whatsapp_chat_id as whatsapp_group_id, 
                            chat_name as whatsapp_group_name,
                            is_group
                        FROM chats
                        WHERE whatsapp_chat_id != 'status@broadcast'
                        ORDER BY is_group DESC, updated_at DESC
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
                    // Construction d'un CTE pour pré-filtrer et afficher les messages
                    const cteBase = `
                        WITH raw_msgs AS (
                            SELECT id, message_id, body, timestamp, is_from_me, is_group, chat_id, sender_id, sender_name, has_media, media_path, media_mime_type, property_group_id, real_property_id, neighborhood, district, municipality, analysis_error, ia_property_id, message_type, is_analyzed, analyzed_at
                            FROM messages 
                            WHERE chat_id = $1
                        ),
                        banned_groups AS (
                            SELECT DISTINCT property_group_id
                            FROM raw_msgs
                            WHERE body ~* 'vendre|vente|parcelle|terrain|titre foncier| tf|domaine'
                            AND property_group_id IS NOT NULL
                        ),
                        filtered_msgs AS (
                            SELECT r.* FROM raw_msgs r
                            LEFT JOIN banned_groups bg ON r.property_group_id = bg.property_group_id
                            WHERE bg.property_group_id IS NULL -- Exclure TOUS les membres d'un groupe contenant 'vendre'
                            AND r.is_analyzed = FALSE
                            AND r.real_property_id IS NULL
                            AND (r.body IS NULL OR r.body !~* 'vendre|vente|parcelle|terrain|titre foncier| tf|domaine') -- Vérif individuelle au cas où (message non groupé)
                            AND ( (r.body IS NOT NULL AND LENGTH(TRIM(r.body)) >= 20) OR r.has_media = TRUE )
                            AND r.message_type NOT IN ('audio', 'ptt', 'sticker')
                        )
                    `;

                    if (before) {
                        query = `
                            ${cteBase}
                            SELECT * FROM (
                                SELECT id, message_id, body, timestamp, is_from_me, is_group, chat_id, sender_id, sender_name, has_media, media_path, media_mime_type, property_group_id, real_property_id, neighborhood, district, municipality, analysis_error, ia_property_id
                                FROM filtered_msgs 
                                WHERE timestamp < $2
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
            
            // --- LOGIQUE DE SOUMISSION RÉUTILISABLE ---
            async function internalProcessPropertySubmission(messageIds) {
                if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) return { success: false, error: "IDs invalides" };

                try {
                    // 1. Récupérer les détails des messages depuis la BD
                    const { rows: fetchedMessages } = await db.query(
                        'SELECT * FROM messages WHERE id = ANY($1) ORDER BY timestamp ASC',
                        [messageIds]
                    );

                    if (fetchedMessages.length === 0) return { success: false, error: "Messages introuvables" };

                    // 2. Fusionner les textes et collecter les images EN BASE64
                    const texts = [];
                    const imagesBase64 = [];
                    let senderPhone = "";

                    // ✅ TRAÇABILITÉ WHATSAPP : Extraire chat_id, chat_name et premier timestamp du groupe
                    const firstMsg = fetchedMessages[0]; // déjà trié ASC par timestamp
                    const whatsappGroupId = firstMsg?.chat_id || null;
                    const whatsappGroupName = firstMsg?.chat_name || null;
                    // Le timestamp WhatsApp est en secondes (Unix epoch) → convertir en ISO string
                    const whatsappFirstMessageAt = firstMsg?.timestamp
                        ? new Date(firstMsg.timestamp * 1000).toISOString()
                        : null;

                    const externalMsg = fetchedMessages.find(m => !m.is_from_me);
                    if (externalMsg) {
                        senderPhone = externalMsg.sender_number || '';
                        if (senderPhone && !senderPhone.startsWith('+')) senderPhone = '+' + senderPhone;
                    }

                    fetchedMessages.forEach(msg => {
                        if (msg.body && msg.body.trim()) {
                            texts.push(msg.body.trim());
                        }
                        const isImageOrVideo = msg.media_mime_type?.startsWith('image/') || msg.media_mime_type?.startsWith('video/');
                        if (msg.has_media && msg.media_path && isImageOrVideo) {
                            const localPath = msg.media_path.startsWith('./') ? msg.media_path : `./${msg.media_path}`;
                            if (fs.existsSync(localPath)) {
                                try {
                                    const imageBuffer = fs.readFileSync(localPath);
                                    const base64Data = imageBuffer.toString('base64');
                                    imagesBase64.push({
                                        data: base64Data,
                                        mimeType: msg.media_mime_type || 'image/jpeg',
                                        extension: localPath.split('.').pop() || 'jpg'
                                    });
                                } catch (readErr) {
                                    console.warn(`⚠️ Erreur lecture média: ${localPath} - ${readErr.message}`);
                                }
                            }
                        }
                    });

                    const finalDescription = texts.join('\n\n').trim() || '(Annonce immobilière WhatsApp - Sans texte)';

                    // FILTRES DE SÉCURITÉ (avec normalisation)
                    const forbiddenKeywords = ['vendre', 'vente', 'parcelle', 'terrain', 'titre foncier', ' tf ', ' tf\n', 'domaine', 'opportunite', 'recherche'];
                    const descriptionNormalized = normalizeStyledText(finalDescription);
                    const foundKeyword = forbiddenKeywords.find(kw => descriptionNormalized.includes(kw));

                    if (foundKeyword) {
                        // Marquer comme noise directement et effacer l'erreur pour qu'il disparaisse des rejets
                        await db.query(`UPDATE messages SET property_group_id = 'noise', submission_failed = TRUE, analysis_error = NULL WHERE id = ANY($1)`, [messageIds]);
                        // Suppression auto du média car c'est du bruit (Vente/Terrain)
                        await deleteMediaFiles(messageIds);
                        return { success: false, error: `Ignoré (Vente/Terrain): "${foundKeyword}"` };
                    }

                    if (imagesBase64.length === 0) {
                        const errMsg = "Au moins une image ou vidéo est requise.";
                        await db.query(`UPDATE messages SET submission_failed = TRUE, analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        return { success: false, error: errMsg };
                    }

                    // 4. Normaliser les abréviations de prix et analyser avec Mistral
                    const normalizedDescription = normalizePriceAbbreviations(finalDescription);
                    console.log(`🤖 Analyse Mistral en cours pour ${texts.length} messages...`);
                    const extractedData = await extractPropertyDataWithAI(normalizedDescription);

                    if (!extractedData) {
                        const errMsg = "L'IA a échoué à analyser l'annonce.";
                        await db.query(`UPDATE messages SET submission_failed = TRUE, analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        return { success: false, error: errMsg };
                    }

                    // Validation du prix du loyer (champ obligatoire)
                    if (!extractedData.rent_price || extractedData.rent_price <= 0) {
                        const errMsg = "Prix du loyer manquant ou invalide dans l'annonce.";
                        await db.query(`UPDATE messages SET submission_failed = TRUE, analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        return { success: false, error: errMsg };
                    }

                    const nestUrl = process.env.NESTJS_API_URL || 'http://host.docker.internal:4000/properties/create-from-whatsapp';
                    
                    try {
                        console.log(`📤 Envoi à NestJS: ${imagesBase64.length} images, groupe: ${whatsappGroupName} (${whatsappGroupId})...`);
                        const response = await axios.post(nestUrl, {
                            description: finalDescription,
                            manager_phone: senderPhone,
                            images_base64: imagesBase64,
                            user_id: process.env.LOCAPAY_BOT_USER_ID || 1,
                            extracted_data: extractedData,
                            // ✅ TRAÇABILITÉ : Métadonnées du groupe WhatsApp source
                            whatsapp_group_id: whatsappGroupId,
                            whatsapp_group_name: whatsappGroupName,
                            whatsapp_first_message_at: whatsappFirstMessageAt
                        }, {
                            timeout: 60000,
                            maxContentLength: 50 * 1024 * 1024,
                            maxBodyLength: 50 * 1024 * 1024
                        });

                        const nestData = response.data?.data || response.data;

                        if (nestData.success) {
                            const property_id = nestData.property_id || nestData.propertyId;
                            const { location } = nestData;
                                `UPDATE messages SET property_group_id = $1, real_property_id = $2, neighborhood = $3, district = $4, municipality = $5, is_analyzed = TRUE, analyzed_at = CURRENT_TIMESTAMP, analysis_error = NULL WHERE id = ANY($6)`,
                                [`real_prop_${property_id}`, property_id, location?.neighborhood || '', location?.district || '', location?.municipality || '', messageIds]
                            );

                            // --- AUTO-PURGE : Suppression des images locales après envoi réussi ---
                            await deleteMediaFiles(messageIds);

                            return { success: true, propertyId: property_id };
                        } else {
                            let errMsg = nestData.error || nestData.message || "Erreur de traitement";
                            await db.query(`UPDATE messages SET submission_failed = TRUE, property_group_id = NULL, real_property_id = NULL, is_analyzed = FALSE, analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                            return { success: false, error: errMsg };
                        }
                    } catch (err) {
                        let errMsg = err.response ? (err.response.data.error || err.response.data.message || `Erreur ${err.response.status}`) : err.message;
                        await db.query(`UPDATE messages SET submission_failed = TRUE, property_group_id = NULL, real_property_id = NULL, is_analyzed = FALSE, analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        return { success: false, error: errMsg };
                    }
                } catch (e) {
                    console.error("❌ internalProcessPropertySubmission error:", e);
                    return { success: false, error: e.message };
                }
            }

            // ROUTE DE GROUPEMENT MANUEL + SOUMISSION À NESTJS

            app.post('/api/messages/submit-property', async (req, res) => {
                const { messageIds } = req.body;
                if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
                    return res.status(400).json({ error: 'Aucun message sélectionné.' });
                }

                // Réponse immédiate
                res.status(202).json({ success: true, message: 'Analyse IA et création en cours...' });

                // Traitement en arrière-plan
                internalProcessPropertySubmission(messageIds).catch(err => {
                    console.error("❌ Async submission error:", err);
                });
            });

            // 🚀 BATCH SUBMIT : Traiter tous les groupements d'un chat
            app.post('/api/messages/batch-submit/:chatId', async (req, res) => {
                const { chatId } = req.params;
                
                try {
                    // 1. Trouver tous les groupes uniques qui n'ont pas encore de real_property_id
                    const { rows: groups } = await db.query(
                        "SELECT DISTINCT property_group_id FROM messages WHERE chat_id = $1 AND property_group_id IS NOT NULL AND property_group_id != 'noise' AND real_property_id IS NULL AND property_group_id NOT LIKE 'real_prop_%' AND submission_failed = FALSE",
                        [chatId]
                    );

                    if (groups.length === 0) {
                        return res.json({ success: true, message: "Aucun nouveau groupement à traiter." });
                    }

                    res.status(202).json({ success: true, message: `Traitement de ${groups.length} groupes lancé en arrière-plan.` });

                    // 2. Traitement séquentiel (plus prudent pour l'IA et NestJS)
                    (async () => {
                        console.log(`🌀 Début du batch processing pour ${groups.length} groupes...`);
                        let successCount = 0;
                        let errorCount = 0;

                        for (const group of groups) {
                            try {
                                const { rows: msgRows } = await db.query(
                                    "SELECT id FROM messages WHERE property_group_id = $1",
                                    [group.property_group_id]
                                );
                                
                                const msgIds = msgRows.map(r => r.id);
                                if (msgIds.length === 0) continue;

                                console.log(`⏳ Batch : traitement du groupe ${group.property_group_id} (${msgIds.length} msgs)...`);
                                const result = await internalProcessPropertySubmission(msgIds);
                                
                                if (result.success) successCount++;
                                else {
                                    errorCount++;
                                    console.warn(`⚠️ Échec groupe ${group.property_group_id} : ${result.error}`);
                                }
                                
                                // Petite pause pour ne pas saturer
                                await new Promise(r => setTimeout(r, 2000));
                            } catch (groupError) {
                                errorCount++;
                                console.error(`❌ Erreur fatale sur le groupe ${group.property_group_id}:`, groupError);
                            }
                        }
                        console.log(`🏁 Batch terminé. Succès: ${successCount}, Échecs: ${errorCount}`);
                    })();

                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // --- FONCTION DE SOUMISSION EN MASSE ---
            async function internalBatchSubmitAll(onProgress = null) {
                try {
                    const { rows: groups } = await db.query(`
                        SELECT DISTINCT property_group_id, chat_id
                        FROM messages
                        WHERE property_group_id IS NOT NULL
                        AND property_group_id != 'noise'
                        AND real_property_id IS NULL
                        AND property_group_id NOT LIKE 'real_prop_%'
                        AND submission_failed = FALSE
                    `);

                    if (groups.length === 0) return { success: 0, errors: 0, total: 0 };

                    let successCount = 0, errorCount = 0;
                    for (let i = 0; i < groups.length; i++) {
                        const group = groups[i];
                        try {
                            const { rows: msgIds } = await db.query(
                                "SELECT id FROM messages WHERE property_group_id = $1",
                                [group.property_group_id]
                            );
                            const result = await internalProcessPropertySubmission(msgIds.map(m => m.id));
                            if (result.success) successCount++;
                            else errorCount++;

                            if (onProgress) {
                                onProgress({ type: 'progress', current: i + 1, total: groups.length, success: successCount, errors: errorCount });
                            }
                            await new Promise(r => setTimeout(r, 2000));
                        } catch (groupError) {
                            errorCount++;
                            if (onProgress) onProgress({ type: 'error', message: groupError.message });
                        }
                    }
                    return { success: successCount, errors: errorCount, total: groups.length };
                } catch (e) {
                    console.error("❌ Error internalBatchSubmitAll:", e);
                    throw e;
                }
            }

            // ⚡ FULL WORKFLOW : Purge + Groupement + Soumission (SSE)
            app.get('/api/chats/full-workflow', async (req, res) => {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

                try {
                    sendEvent({ type: 'progress', message: '🧹 Étape 1/3 : Purge du bruit en cours...' });
                    const purgeCount = await internalPurgeNoise();
                    sendEvent({ type: 'progress', message: `✅ Purge terminée (${purgeCount} messages).` });

                    sendEvent({ type: 'progress', message: '🤖 Étape 2/3 : Analyse et groupement automatique...' });
                    const runAll = app.get('runAutoGroupHeuristicAllChats');
                    if (runAll) await runAll();
                    sendEvent({ type: 'progress', message: '✅ Groupement terminé.' });

                    sendEvent({ type: 'progress', message: '🚀 Étape 3/3 : Soumission des biens à NestJS...' });
                    const result = await internalBatchSubmitAll(sendEvent);
                    
                    sendEvent({ type: 'complete', message: `✨ Workflow terminé : ${result.success} nouveaux biens.`, ...result });
                    res.end();
                } catch (e) {
                    sendEvent({ type: 'error', message: e.message });
                    res.end();
                }
            });

            // 🔄 WORKFLOW AUTOMATISE (CRON)
            async function globalAutomatedWorkflow() {
                console.log('🕒 --- DÉBUT DU WORKFLOW AUTOMATISÉ (30 min) ---');
                try {
                    // 1. Purge
                    console.log('🕒 Étape 1/3 : Grande Purge...');
                    const purgeCount = await internalPurgeNoise();
                    console.log(`🕒 Purge terminée : ${purgeCount} messages nettoyés.`);

                    // 2. Analyse / Groupement
                    console.log('🕒 Étape 2/3 : Analyse et Groupement...');
                    const runAll = app.get('runAutoGroupHeuristicAllChats');
                    if (runAll) await runAll();
                    console.log('🕒 Analyse terminée.');

                    // 3. Soumission
                    console.log('🕒 Étape 3/3 : Soumission en lot...');
                    const submitResult = await internalBatchSubmitAll();
                    console.log(`🕒 Soumission terminée : ${submitResult.success} succès, ${submitResult.errors} erreurs.`);

                    console.log('🕒 --- WORKFLOW AUTOMATISÉ TERMINÉ AVEC SUCCÈS ---');
                } catch (e) {
                    console.error('🕒 ❌ ERREUR DANS LE WORKFLOW AUTOMATISÉ:', e.message);
                }
            }
            app.set('globalAutomatedWorkflow', globalAutomatedWorkflow);

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

            // 🔓 API FULL ACCESS : Récupérer toutes les conversations sans aucun filtre
            app.get('/api/full/chats', async (req, res) => {
                try {
                    const query = `
                        SELECT c.*, 
                               (SELECT COUNT(*) FROM messages WHERE chat_id = c.whatsapp_chat_id) as unread_count
                        FROM chats c
                        WHERE c.whatsapp_chat_id != 'status@broadcast'
                        ORDER BY c.updated_at DESC
                    `;
                    const { rows } = await db.query(query);
                    res.json(rows);
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            // 🔓 API FULL ACCESS : Récupérer tous les messages d'une conversation sans aucun filtre
            app.get('/api/full/messages/:chatId', async (req, res) => {
                try {
                    const { before, limit = 50 } = req.query;
                    const safeLimit = Math.min(parseInt(limit) || 50, 200);

                    let query, params;
                    if (before) {
                        query = `
                            SELECT * FROM (
                                SELECT id, message_id, body, timestamp, is_from_me, is_group, chat_id, sender_id, sender_name, has_media, media_path, media_mime_type, property_group_id, real_property_id, neighborhood, district, municipality, analysis_error, ia_property_id
                                FROM messages 
                                WHERE chat_id = $1 AND timestamp < $2
                                ORDER BY timestamp DESC 
                                LIMIT $3
                            ) AS sub 
                            ORDER BY timestamp ASC
                        `;
                        params = [req.params.chatId, before, safeLimit];
                    } else {
                        query = `
                            SELECT * FROM (
                                SELECT id, message_id, body, timestamp, is_from_me, is_group, chat_id, sender_id, sender_name, has_media, media_path, media_mime_type, property_group_id, real_property_id, neighborhood, district, municipality, analysis_error, ia_property_id
                                FROM messages 
                                WHERE chat_id = $1
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
                    // Alert email only for critical Puppeteer/WWebJS errors
                    if (error.message.includes('detached Frame') || error.message.includes('getChat') || error.message.includes('Execution context was destroyed')) {
                        await sendErrorAlert("Échec d'envoi de message (Erreur Critique)", error);
                    }
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
    bypassCSP: true,
    protocolTimeout: 120000, // ⏳ Augmentation du timeout (120s) pour les VPS lents
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process', // ← FIX: évite la destruction du contexte dans Docker
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
    puppeteer: puppeteerOptions
});

// --- SYSTÈME DE WATCHDOG (INACTIVITÉ) ---
let lastMessageReceivedAt = Date.now();
let inactivityAlertSent = false;

// Vérification toutes les 30 minutes
setInterval(async () => {
    const hoursSinceLastMessage = (Date.now() - lastMessageReceivedAt) / (1000 * 60 * 60);
    
    // Si plus de 2h d'inactivité et qu'on n'a pas encore envoyé l'alerte
    if (hoursSinceLastMessage >= 2 && !inactivityAlertSent && botStatus === 'CONNECTED') {
        await sendErrorAlert(
            "Inactivité suspecte (2h+)", 
            `Le bot n'a reçu aucun message depuis ${Math.round(hoursSinceLastMessage)} heures. Il est peut-être gelé ou déconnecté silencieusement.`
        );
        inactivityAlertSent = true; // Évite de spammer des mails toutes les 30 min
    }
}, 30 * 60 * 1000);

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

    // ✅ ACTIVÉ : Balayage automatique périodique (Workflow complet : Purge + Groupement + Soumission)
    console.log('🤖 Activation du workflow automatisé complet (toutes les 30 min)...');
    const globalWorkflow = app.get('globalAutomatedWorkflow');
    if (globalWorkflow) {
        // Premier lancement après 1 minute (laisser le temps au bot de se stabiliser)
        setTimeout(() => {
            globalWorkflow().catch(e => console.error("❌ Error initial workflow:", e));
        }, 60 * 1000);

        // Puis toutes les 30 minutes
        setInterval(() => {
            globalWorkflow().catch(err => console.error("❌ Erreur workflow automatisé:", err));
        }, 30 * 60 * 1000);
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
    console.log('❌ Client déconnecté. Veuillez scanner à nouveau !');
    botStatus = 'DISCONNECTED';
    sendErrorAlert("Bot DISCONNECTED", "Le bot a été déconnecté de WhatsApp. Il faut probablement rescanner le QR Code.");
});

client.on('message_create', async msg => {
    // Mise à jour du watchdog à chaque nouveau message
    lastMessageReceivedAt = Date.now();
    inactivityAlertSent = false; 

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

        // 🤖 NOUVELLE RÈGLE : Message complet (texte > 100 chars + média image/vidéo) → groupe autonome
        if (messageData.hasMedia && messageData.body && messageData.body.length > 100 &&
            (messageData.mediaMimeType?.startsWith('image/') || messageData.mediaMimeType?.startsWith('video/')) &&
            !messageData.isFromMe && currId) {
            const groupId = `auto_prop_self_${currId}`;
            await db.query("UPDATE messages SET property_group_id = $1 WHERE id = $2", [groupId, currId]);
            console.log(`📎 Message complet auto-groupé : ${groupId}`);
        }

        // 🤖 HEURISTIQUE DE GROUPEMENT AUTOMATIQUE (Simplification demandée par le USER)
        // Règle : Si un texte > 100 chars (SANS média) est suivi par un média du même expéditeur, on groupe.
        // ✅ ACTIVÉ : Auto-groupement en temps réel
        else if (messageData.hasMedia && !messageData.isFromMe) {
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


(async () => {
    const maxRetries = 10;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔄 Tentative d'initialisation WhatsApp (${attempt}/${maxRetries})...`);
            await client.initialize();
            break; // succès → on sort de la boucle
        } catch (err) {
            console.error(`❌ Echec tentative ${attempt}: ${err.message}`);
            if (attempt < maxRetries) {
                console.log(`⏳ Nouvelle tentative dans 5 secondes...`);
                await new Promise(r => setTimeout(r, 5000));
            } else {
                console.error('❌ Toutes les tentatives ont échoué. Arrêt.');
                process.exit(1);
            }
        }
    }
})();
