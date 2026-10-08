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
const multer = require('multer');
const {
    importFacebookPosts,
    processFacebookBatch,
    processFacebookPost,
    extractPropertyDataDeterministic
} = require('./facebook-processor');
const { buildScrapeReportQuery } = require('./facebook-scrape-report-query');

// Multer : stockage en mémoire pour les uploads JSON Facebook (légers < 10MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
            cb(null, true);
        } else {
            cb(new Error('Seuls les fichiers JSON Apify sont acceptés'));
        }
    },
});


// --- SETUP SERVEUR WEB (Frontend & API) ---
const app = express();
const configuredCorsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
app.use(cors({ origin: configuredCorsOrigins.length ? configuredCorsOrigins : false }));
app.use(express.json()); // Support pour le JSON dans les requêtes POST
app.use(express.static(path.join(__dirname, 'frontend-dist')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(__dirname, 'media')));

// Les routes internes de l'enrichisseur ne doivent jamais être accessibles au
// navigateur. La même clé est configurée dans NestJS, le bot et le worker PM2.
function requireFacebookMediaEnrichmentToken(req, res, next) {
    const expected = process.env.FACEBOOK_MEDIA_ENRICHMENT_TOKEN;
    const provided = req.get('x-facebook-media-token');
    if (!expected) {
        console.error('❌ FACEBOOK_MEDIA_ENRICHMENT_TOKEN est absent : route interne refusée.');
        return res.status(503).json({ error: 'Service interne non configuré' });
    }
    if (!provided || provided !== expected) {
        return res.status(401).json({ error: 'Accès interne non autorisé' });
    }
    next();
}

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

// État global du collecteur WhatsApp pour le frontend.
let botStatus = 'STARTING'; // STARTING, QR, AUTHENTICATED, CONNECTED, DISCONNECTED, ERROR
let currentQR = null;
const realtimeClients = new Set();
const syncedWhatsAppChatTimestamps = new Map();
let whatsappHistorySyncTimer = null;
let whatsappHistorySyncInProgress = false;
// Minuit du jour courant à Porto-Novo, exprimé en timestamp Unix. Les messages
// WhatsApp sont enregistrés avec un timestamp Unix, donc ce filtre reste exact
// même si le serveur Docker tourne en UTC.
const TODAY_START_PORTO_NOVO_SQL = "EXTRACT(EPOCH FROM date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Porto-Novo') AT TIME ZONE 'Africa/Porto-Novo')::BIGINT";

function broadcastRealtimeEvent(type, payload = {}) {
    const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const clientResponse of realtimeClients) {
        try {
            clientResponse.write(message);
        } catch (_) {
            realtimeClients.delete(clientResponse);
        }
    }
}

function setBotStatus(status, extra = {}) {
    botStatus = status;
    broadcastRealtimeEvent('bot_status', { status, hasQr: Boolean(currentQR), ...extra });
}

// Ces routes restent accessibles pendant l'initialisation de PostgreSQL :
// l'interface peut donc immédiatement présenter le QR de connexion.
app.get('/api/status', (_req, res) => {
    res.json({ status: botStatus, hasQr: Boolean(currentQR) });
});

app.get('/api/qr', (_req, res) => {
    res.json({ qr: currentQR });
});

app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    realtimeClients.add(res);
    res.write(`event: bot_status\ndata: ${JSON.stringify({ status: botStatus, hasQr: Boolean(currentQR) })}\n\n`);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
        clearInterval(heartbeat);
        realtimeClients.delete(res);
    });
});

app.listen(3000, () => {
    console.log('✅ Frontend et API Web disponibles sur http://localhost:3000');
});

// ── Recalcul hebdomadaire des Tiers de scraping (cooldown_hours) ─────────────
// Classe chaque groupe Facebook en Tier A (2h), Tier B (4h) ou Tier C (6h)
// selon le nombre de biens réellement créés sur LocaPay dans les 30 derniers jours.
// Tier A : > 300 biens/30j (mines d'or) → scrapé toutes les 2h
// Tier B : 30 à 300 biens/30j (rentables) → scrapé toutes les 4h
// Tier C : < 30 biens/30j (faible rendement) → scrapé toutes les 6h
async function recalculateTiers(db) {
    try {
        const result = await db.query(`
            WITH rendement AS (
              SELECT
                fp.group_id,
                COUNT(fp.post_id) FILTER (WHERE fp.is_processed = TRUE AND fp.real_property_id IS NOT NULL) AS biens_30j
              FROM facebook_posts fp
              WHERE fp.scraped_at >= NOW() - INTERVAL '30 days'
              GROUP BY fp.group_id
            )
            UPDATE facebook_groups fg
            SET cooldown_hours = CASE
              WHEN r.biens_30j > 300 THEN 2
              WHEN r.biens_30j >= 30  THEN 4
              ELSE 6
            END
            FROM rendement r
            WHERE fg.group_id = r.group_id
            RETURNING fg.group_id, fg.cooldown_hours
        `);
        const tierA = result.rows.filter(r => r.cooldown_hours === 2).length;
        const tierB = result.rows.filter(r => r.cooldown_hours === 4).length;
        const tierC = result.rows.filter(r => r.cooldown_hours === 6).length;
        console.log(`✅ [Tiers] Recalcul terminé — Tier A: ${tierA} groupes (2h) | Tier B: ${tierB} groupes (4h) | Tier C: ${tierC} groupes (6h)`);
    } catch (err) {
        console.error('❌ [Tiers] Erreur lors du recalcul des cooldowns:', err.message);
    }
}
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

// Variable pour la sécurité anti-spam des alertes OpenRouter (1h = 3600000ms)
let lastAiAlertTime = 0;

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
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL est obligatoire : configurez-la dans .env avant de démarrer le collecteur.');
}
const db = new Pool({ connectionString: process.env.DATABASE_URL });

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
                if (process.env.MEDIA_RETENTION_PURGE !== 'true') {
                    // Par défaut, l'archive est complète : les pièces jointes restent disponibles.
                    return;
                }
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

            // --- NETTOYAGE PÉRIODIQUE DES MÉDIAS ANALYSÉS ---
            const cleanupAnalyzedMedia = async () => {
                if (process.env.MEDIA_RETENTION_PURGE !== 'true') return 0;
                try {
                    // Supprimer les médias des messages avec un bien créé, analysés, ou marqués comme noise
                    const { rows } = await db.query(`
                        SELECT id, media_path FROM messages
                        WHERE media_path IS NOT NULL
                        AND (real_property_id IS NOT NULL OR is_analyzed = TRUE OR property_group_id = 'noise')
                    `);

                    if (rows.length === 0) {
                        console.log('🧹 Aucun média à nettoyer.');
                        return 0;
                    }

                    let deletedCount = 0;
                    for (const row of rows) {
                        const localPath = path.resolve(__dirname, row.media_path);
                        if (fs.existsSync(localPath)) {
                            fs.unlinkSync(localPath);
                            deletedCount++;
                        }
                    }

                    // Mettre à jour la DB
                    await db.query(`
                        UPDATE messages SET media_path = NULL
                        WHERE media_path IS NOT NULL
                        AND (real_property_id IS NOT NULL OR is_analyzed = TRUE OR property_group_id = 'noise')
                    `);

                    console.log(`🧹 Nettoyage terminé : ${deletedCount} fichiers supprimés.`);
                    return deletedCount;
                } catch (err) {
                    console.error("❌ Erreur nettoyage médias:", err.message);
                    return 0;
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

            // ── TABLES FACEBOOK ─────────────────────────────────────────────
            await db.query(`
                CREATE TABLE IF NOT EXISTS facebook_groups (
                    id SERIAL PRIMARY KEY,
                    group_id TEXT UNIQUE NOT NULL,
                    group_url TEXT,
                    group_name TEXT,
                    last_scraped_at TIMESTAMPTZ DEFAULT NOW(),
                    most_recent_post_at TIMESTAMPTZ,
                    most_recent_post_id TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await db.query(`
                CREATE TABLE IF NOT EXISTS facebook_posts (
                    id SERIAL PRIMARY KEY,
                    post_id TEXT UNIQUE NOT NULL,
                    group_id TEXT REFERENCES facebook_groups(group_id),
                    author TEXT,
                    text TEXT,
                    image_urls JSONB DEFAULT '[]',
                    video_url TEXT,
                    post_url TEXT,
                    scraped_at TIMESTAMPTZ,
                    estimated_post_at TIMESTAMPTZ,
                    phone_extracted TEXT,
                    is_processed BOOLEAN DEFAULT FALSE,
                    is_noise BOOLEAN DEFAULT FALSE,
                    real_property_id INTEGER,
                    analysis_error TEXT,
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await db.query('CREATE INDEX IF NOT EXISTS idx_fb_posts_group ON facebook_posts(group_id);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_fb_posts_processed ON facebook_posts(is_processed, is_noise);');
            await db.query('CREATE INDEX IF NOT EXISTS idx_fb_posts_scraped ON facebook_posts(scraped_at DESC);');

            // Garantir que les nouvelles colonnes soient ajoutées si la table a été créée précédemment sans elles
            await db.query('ALTER TABLE facebook_posts ADD COLUMN IF NOT EXISTS video_url TEXT;');
            await db.query('ALTER TABLE facebook_posts ADD COLUMN IF NOT EXISTS is_noise BOOLEAN DEFAULT FALSE;');
            await db.query('ALTER TABLE facebook_posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();');
            await db.query('ALTER TABLE facebook_posts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();');
            await db.query('ALTER TABLE facebook_posts ADD COLUMN IF NOT EXISTS is_client_demand BOOLEAN DEFAULT FALSE;');
            // File durable : un seul enrichissement de galerie par bien validé.
            // Elle vit ici car le bot est le seul à connaître le post Facebook
            // (post_url) associé au real_property_id créé par NestJS.
            await db.query(`
                CREATE TABLE IF NOT EXISTS facebook_media_enrichment_jobs (
                    id SERIAL PRIMARY KEY,
                    property_id INTEGER UNIQUE NOT NULL,
                    facebook_post_id TEXT REFERENCES facebook_posts(post_id),
                    post_url TEXT NOT NULL,
                    known_image_urls JSONB NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    locked_at TIMESTAMPTZ,
                    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    completed_at TIMESTAMPTZ,
                    last_error TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await db.query(`CREATE INDEX IF NOT EXISTS idx_fb_media_jobs_pending
                ON facebook_media_enrichment_jobs(status, next_attempt_at);`);
            await db.query(`ALTER TABLE facebook_media_enrichment_jobs
                ADD COLUMN IF NOT EXISTS known_image_urls JSONB NOT NULL DEFAULT '[]';`);
            await db.query('ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS is_validated BOOLEAN DEFAULT NULL;');
            await db.query('ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS cooldown_hours INTEGER NOT NULL DEFAULT 6;');
            // État de couverture : ajouté sans modifier les posts ni le pipeline de modération.
            await db.query('ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_scrape_attempt_at TIMESTAMPTZ;');
            await db.query('ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_complete_oldest_post_at TIMESTAMPTZ;');
            await db.query("ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_scrape_status TEXT NOT NULL DEFAULT 'pending';");
            await db.query('ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_scrape_limit INTEGER;');
            await db.query('ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_scrape_count INTEGER;');
            await db.query('ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS consecutive_limit_hits INTEGER NOT NULL DEFAULT 0;');
            await db.query('ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS next_scrape_at TIMESTAMPTZ;');
            // Checkpoint exact de reprise. Il n'est modifié que par un rapport
            // de couverture complet, jamais par les imports progressifs.
            await db.query('ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS most_recent_post_id TEXT;');
            await db.query('CREATE INDEX IF NOT EXISTS idx_fb_groups_next_scrape ON facebook_groups(next_scrape_at);');

            console.log('✅ Tables Facebook (facebook_groups, facebook_posts) prêtes.');
            // ────────────────────────────────────────────────────────────────



            // --- PRÉ-TRAITEMENT DES ABRÉVIATIONS DE PRIX ---
            // Normalise les abréviations locales (mille, milles, mil, k) avant envoi à l'IA
            // Ex: "28mil" → "28000", "1.5mil" → "1500", "50k" → "50000", "27MILLES" → "27000"
            function normalizePriceAbbreviations(text) {
                return text.replace(/(\d+)[.,]?(\d*)\s*(milles?|mil|k)\b/gi, (match, int, dec, unit) => {
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

            // --- FONCTION D'EXTRACTION IA OPENROUTER ---
            async function extractPropertyDataWithAI(description) {
                const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
                const AI_MODEL = process.env.AI_MODEL || 'deepseek/deepseek-v4-flash';

                if (!OPENROUTER_API_KEY) {
                    console.error("❌ OPENROUTER_API_KEY manquante dans le .env du Bot");
                    return null;
                }

                const prompt = `
Tu es un extracteur de données immobilières pour WhatsApp. Analyse la description suivante et extrait les informations selon les champs spécifiés (JSON uniquement).

⚠️ RÈGLES CRITIQUES :
1. NE JAMAIS INVENTER d'informations. Si le prix n'est pas mentionné, retourne "rent_price": null.
2. PRIORITÉ TYPE : Si un texte mentionne un usage commercial (boutique ou magasin), ce type est PRIORITAIRE pour le champ "type" même s'il y a des chambres/salons.
3. TYPES : "Magasin" -> STORE, "Boutique" -> SHOP.
4. TARIFICATION JOURNALIÈRE (PRIORITÉ ABSOLUE) : Si l'annonce mentionne une location à la nuitée, par nuit, par jour, "court séjour", "meublé courte durée", "location journalière", ou tout prix exprimé par nuit/jour (ex: "25000/nuit", "15000 la nuit", "35000/j"), alors retourne "tarification": "DAILY".
   Ces biens ne sont PAS acceptés sur la plateforme. Seule la tarification mensuelle (MONTHLY) est valide.

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


                // Fonction interne pour réutiliser l'appel API
                const doApiCall = () => axios.post('https://openrouter.ai/api/v1/chat/completions', {
                    model: AI_MODEL,
                    messages: [
                        { role: 'system', content: 'Tu es un expert en analyse immobilière. Réponds uniquement en JSON valide sans bloc markdown.' },
                        { role: 'user', content: prompt }
                    ],
                    response_format: { type: 'json_object' }
                }, {
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'http://localhost:3000',
                        'X-Title': 'LocaPay Scraper'
                    },
                    timeout: 45000
                });

                try {
                    let response;
                    try {
                        response = await doApiCall();
                    } catch (firstErr) {
                        // Si 429 (rate limit), on attend 10s et on réessaie UNE fois
                        if (firstErr.response?.status === 429) {
                            console.warn(`⚠️ [WhatsApp] Erreur 429 détectée. Pause de 10s avant retry...`);
                            await new Promise(r => setTimeout(r, 10000));
                            response = await doApiCall();
                        } else {
                            throw firstErr;
                        }
                    }

                    const content = response.data.choices[0].message.content.trim();
                    return JSON.parse(content);
                } catch (error) {
                    const status = error.response?.status;
                    if (status === 401 || status === 429 || status === 402) {
                        console.error(`❌ Erreur OpenRouter AI FATALE (${status}):`, error.message);

                        // Sécurité anti-spam : Envoi d'un mail maximum par heure
                        const now = Date.now();
                        if (now - lastAiAlertTime > 3600000) {
                            let reason = "L'API OpenRouter est bloquée. Raison inconnue.";
                            let title = "OpenRouter AI bloqué";
                            if (status === 429) {
                                reason = "Blocage temporaire : Trop de requêtes envoyées en même temps (Erreur 429 - Rate Limit). Le système a juste besoin de ralentir.";
                                title = "OpenRouter AI - Trop de requêtes (429)";
                            } else if (status === 402 || (error.response?.data?.error?.message && error.response.data.error.message.toLowerCase().includes('credit'))) {
                                reason = "Blocage financier : Vous n'avez plus d'argent / de crédits sur votre compte OpenRouter (Erreur 402). Rechargez votre compte.";
                                title = "OpenRouter AI - Plus de crédits (402)";
                            } else if (status === 401) {
                                reason = "Blocage d'accès : La clé API OpenRouter est invalide (Erreur 401).";
                            }

                            sendErrorAlert(title, `Erreur HTTP ${status} - ${reason}\n\nLe traitement a été suspendu pour cet élément.`);
                            lastAiAlertTime = now;
                        }

                        throw new Error('OPENROUTER_QUOTA_EXCEEDED');
                    }
                    console.error("❌ Erreur OpenRouter AI dans le Bot:", error.message);
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

            // 🧹 Nettoyage manuel des médias analysés
            app.post('/api/cleanup-media', async (req, res) => {
                try {
                    const count = await cleanupAnalyzedMedia();
                    res.json({ success: true, message: `${count} fichiers médias supprimés.` });
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
                const FORBIDDEN_REGEX = 'vendre|vente|parcelle|terrain|titre\\sfoncier|\\stf\\s|\\stf\n|domaine|\\stf$|opportunite|recherche|pièces\\sà\\sjour|pieces\\sa\\sjour|état\\sboutique|etat\\sboutique|guéridon|gueridon|matelas|galet|toyota|honda|ford';
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
                        AND NOT (m.body ~* 'vendre|vente|parcelle|terrain|titre\\sfoncier|\\stf\\s|\\stf\n|domaine|\\stf$|opportunite|recherche|pièces\\sà\\sjour|pieces\\sa\\sjour|état\\sboutique|etat\\sboutique|guéridon|gueridon|matelas|galet|toyota|honda|ford')
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
                        AND NOT (m.body ~* 'vendre|vente|parcelle|terrain|titre\\sfoncier|\\stf\\s|\\stf\n|domaine|\\stf$|opportunite|recherche|pièces\\sà\\sjour|pieces\\sa\\sjour|état\\sboutique|etat\\sboutique|guéridon|gueridon|matelas|galet|toyota|honda|ford')
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
                            WHERE body ~* 'vendre|vente|parcelle|terrain|titre foncier| tf|domaine|pièces à jour|pieces a jour|état boutique|etat boutique|guéridon|gueridon|matelas|galet|toyota|honda|ford'
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
                            AND m.timestamp >= ${TODAY_START_PORTO_NOVO_SQL}
                            AND bg.property_group_id IS NULL -- Exclure les membres d'un groupe interdit
                            AND COALESCE(m.message_type, '') NOT IN ('audio', 'ptt', 'sticker')
                            AND (m.body IS NULL OR m.body !~* 'vendre|vente|parcelle|terrain|titre foncier| tf|domaine|pièces à jour|pieces a jour|état boutique|etat boutique|guéridon|gueridon|matelas|galet|toyota|honda|ford')
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
                        AND EXISTS (
                            SELECT 1 FROM messages
                            WHERE chat_id = chats.whatsapp_chat_id
                            AND timestamp >= ${TODAY_START_PORTO_NOVO_SQL}
                        )
                        ORDER BY is_group DESC, updated_at DESC
                    `;
                    const { rows } = await db.query(query);
                    res.json(rows);
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            /**
             * GET /api/chats/:chatId/daily-stats
             * Statistiques journalières pour une conversation/groupe WhatsApp spécifique
             */
            app.get('/api/chats/:chatId/daily-stats', async (req, res) => {
                try {
                    const { chatId } = req.params;
                    const { rows } = await db.query(`
                        SELECT 
                            DATE(TO_TIMESTAMP(timestamp)) as day,
                            COUNT(*) as message_count,
                            COUNT(*) FILTER (WHERE is_from_me = TRUE) as sent_count,
                            COUNT(*) FILTER (WHERE is_from_me = FALSE) as received_count,
                            COUNT(*) FILTER (WHERE has_media = TRUE) as media_count
                        FROM messages
                        WHERE chat_id = $1
                        GROUP BY DATE(TO_TIMESTAMP(timestamp))
                        ORDER BY day DESC;
                    `, [chatId]);
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
                            WHERE body ~* 'vendre|vente|parcelle|terrain|titre foncier| tf|domaine|pièces à jour|pieces a jour|état boutique|etat boutique|guéridon|gueridon|matelas|galet|toyota|honda|ford'
                            AND property_group_id IS NOT NULL
                        ),
                        filtered_msgs AS (
                            SELECT r.* FROM raw_msgs r
                            LEFT JOIN banned_groups bg ON r.property_group_id = bg.property_group_id
                            WHERE bg.property_group_id IS NULL -- Exclure TOUS les membres d'un groupe contenant 'vendre'
                            AND r.is_analyzed = FALSE
                            AND r.real_property_id IS NULL
                            AND (r.body IS NULL OR r.body !~* 'vendre|vente|parcelle|terrain|titre foncier| tf|domaine|pièces à jour|pieces a jour|état boutique|etat boutique|guéridon|gueridon|matelas|galet|toyota|honda|ford') -- Vérif individuelle au cas où (message non groupé)
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
                    const forbiddenKeywords = ['vendre', 'vente', 'parcelle', 'terrain', 'titre foncier', ' tf ', ' tf\n', 'domaine', 'opportunite', 'recherche', 'pièces à jour', 'pieces a jour', 'état boutique', 'etat boutique', 'guéridon', 'gueridon', 'matelas', 'galet', 'toyota', 'honda', 'ford'];
                    const descriptionNormalized = normalizeStyledText(finalDescription);
                    const foundKeyword = forbiddenKeywords.find(kw => descriptionNormalized.includes(kw));

                    if (foundKeyword) {
                        // Marquer comme noise directement et effacer l'erreur pour qu'il disparaisse des rejets
                        await db.query(`UPDATE messages SET property_group_id = 'noise', submission_failed = TRUE, analysis_error = NULL WHERE id = ANY($1)`, [messageIds]);
                        // Suppression auto du média car c'est du bruit (Vente/Terrain)
                        await deleteMediaFiles(messageIds);
                        return { success: false, error: `Ignoré (Vente/Terrain): "${foundKeyword}"` };
                    }

                    const hasVideo = imagesBase64.some(media => media.mimeType.startsWith('video/'));
                    if (!hasVideo && imagesBase64.length < 3) {
                        await db.query(`UPDATE messages SET property_group_id = 'noise', submission_failed = TRUE, analysis_error = NULL WHERE id = ANY($1)`, [messageIds]);
                        await deleteMediaFiles(messageIds);
                        return { success: false, error: `Ignoré: Moins de 3 images fournies (${imagesBase64.length})` };
                    }

                    // 4. Analyser avec l'Algorithme Déterministe
                    console.log(`⚡ Analyse Regex (Déterministe) en cours pour ${texts.length} messages...`);
                    const extractedData = extractPropertyDataDeterministic(finalDescription);

                    if (!extractedData) {
                        const errMsg = "L'algorithme déterministe a échoué à analyser l'annonce.";
                        await db.query(`UPDATE messages SET submission_failed = TRUE, analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        return { success: false, error: errMsg };
                    }

                    // Validation du prix du loyer (champ obligatoire)
                    if (!extractedData.rent_price || extractedData.rent_price <= 0) {
                        const errMsg = "Prix du loyer manquant ou invalide dans l'annonce.";
                        await db.query(`UPDATE messages SET submission_failed = TRUE, analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        return { success: false, error: errMsg };
                    }

                    // Filtrer les locations journalières (à la nuitée / par jour)
                    if (extractedData.tarification === 'DAILY') {
                        const errMsg = 'Location journalière (DAILY) non acceptée';
                        await db.query(
                            `UPDATE messages SET submission_failed = TRUE, property_group_id = 'noise', analysis_error = $1 WHERE id = ANY($2)`,
                            [errMsg, messageIds]
                        );
                        console.log(`🚫 [WhatsApp] Groupe ${messageIds} → noise (location journalière DAILY détectée)`);
                        return { success: false, error: errMsg };
                    }

                    // --- ASSOUPLISSEMENT (Eviter les crashs NestJS pour les champs manquants) ---
                    if (extractedData && extractedData.type) {
                        const t = extractedData.type.toUpperCase();
                        // Commerciaux / 1-pièce
                        if (['STORE', 'SHOP', 'OFFICE', 'BOUTIQUE', 'MAGASIN', 'STUDIO', 'ROOM'].includes(t)) {
                            if (extractedData.number_rooms === undefined || extractedData.number_rooms === null || extractedData.number_rooms === '') {
                                extractedData.number_rooms = 1;
                            }
                            if (extractedData.number_living_rooms === undefined || extractedData.number_living_rooms === null || extractedData.number_living_rooms === '') {
                                extractedData.number_living_rooms = 0;
                            }
                        }
                        // Habitations classiques
                        if (['APARTMENT', 'HOUSE', 'VILLA'].includes(t)) {
                            if (extractedData.number_rooms === undefined || extractedData.number_rooms === null || extractedData.number_rooms === '') {
                                extractedData.number_rooms = 1;
                            }
                            if (extractedData.number_living_rooms === undefined || extractedData.number_living_rooms === null || extractedData.number_living_rooms === '') {
                                extractedData.number_living_rooms = 1;
                            }
                        }
                    }


                    // ✅ VALIDATION : Numéro de téléphone obligatoire — jamais de fallback
                    if (!senderPhone) {
                        const errMsg = 'Numéro de téléphone de l\'expéditeur introuvable — post ignoré';
                        await db.query(`UPDATE messages SET submission_failed = TRUE, analysis_error = $1 WHERE id = ANY($2)`, [errMsg, messageIds]);
                        console.log(`🚫 [WhatsApp] Groupe ${messageIds} → ignoré (aucun numéro de téléphone extractible)`);
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

                            await db.query(
                                `UPDATE messages 
                                SET property_group_id = $1, 
                                    real_property_id = $2, 
                                    neighborhood = $3, 
                                    district = $4, 
                                    municipality = $5, 
                                    is_analyzed = TRUE, 
                                    analyzed_at = CURRENT_TIMESTAMP, 
                                    analysis_error = NULL 
                                WHERE id = ANY($6)`,
                                [
                                    `real_prop_${property_id}`,
                                    property_id,
                                    location?.neighborhood || '',
                                    location?.district || '',
                                    location?.municipality || '',
                                    messageIds
                                ]
                            );

                            // --- AUTO-PURGE ---
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
                console.log('🕒 --- DÉBUT DU WORKFLOW AUTOMATISÉ (2 min) ---');
                try {
                    // 1. Purge
                    console.log('🕒 Étape 1/4 : Grande Purge...');
                    const purgeCount = await internalPurgeNoise();
                    console.log(`🕒 Purge terminée : ${purgeCount} messages nettoyés.`);

                    // 2. Analyse / Groupement
                    console.log('🕒 Étape 2/4 : Analyse et Groupement...');
                    const runAll = app.get('runAutoGroupHeuristicAllChats');
                    if (runAll) await runAll();
                    console.log('🕒 Analyse terminée.');

                    // 3. Soumission
                    console.log('🕒 Étape 3/4 : Soumission en lot...');
                    const submitResult = await internalBatchSubmitAll();
                    console.log(`🕒 Soumission terminée : ${submitResult.success} succès, ${submitResult.errors} erreurs.`);

                    // 4. Nettoyage des médias
                    console.log('🕒 Étape 4/4 : Nettoyage des médias...');
                    const cleanedCount = await cleanupAnalyzedMedia();
                    console.log(`🕒 Nettoyage terminé : ${cleanedCount} fichiers supprimés.`);

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
                               (SELECT COUNT(*) FROM messages WHERE chat_id = c.whatsapp_chat_id AND timestamp >= ${TODAY_START_PORTO_NOVO_SQL}) as unread_count
                        FROM chats c
                        WHERE c.whatsapp_chat_id != 'status@broadcast'
                        AND EXISTS (SELECT 1 FROM messages WHERE chat_id = c.whatsapp_chat_id AND timestamp >= ${TODAY_START_PORTO_NOVO_SQL})
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
                                WHERE chat_id = $1 AND timestamp < $2 AND timestamp >= 1781913600
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
                                WHERE chat_id = $1 AND timestamp >= 1781913600
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

            // ═══════════════════════════════════════════════════════════════
            // ──────────────── ROUTES FACEBOOK SCRAPER ───────────────────────
            // ═══════════════════════════════════════════════════════════════

            /**
             * POST /api/facebook/upload
             * Upload d'un fichier JSON Apify + nom du groupe Facebook.
             * Insère les posts dans facebook_posts, pré-filtre sans média.
             * Body: multipart/form-data — champ "file" (JSON) + "group_name" (text)
             */
            app.post('/api/facebook/upload', upload.single('file'), async (req, res) => {
                try {
                    if (!req.file) {
                        return res.status(400).json({ error: 'Aucun fichier fourni (champ "file" requis)' });
                    }

                    let posts;
                    try {
                        posts = JSON.parse(req.file.buffer.toString('utf-8'));
                    } catch (parseErr) {
                        return res.status(400).json({ error: 'Fichier JSON invalide : ' + parseErr.message });
                    }

                    if (!Array.isArray(posts)) {
                        return res.status(400).json({ error: 'Le JSON doit être un tableau de posts' });
                    }

                    // groupName est extrait automatiquement du postId dans importFacebookPosts
                    const explicitGroupId = req.body.group_id;
                    const result = await importFacebookPosts(posts, db, explicitGroupId);

                    res.json({
                        success: true,
                        message: `Import terminé`,
                        inserted: result.inserted,
                        duplicates: result.duplicates,
                        noMediaNoise: result.noMediaNoise,
                        readyToProcess: result.inserted - result.noMediaNoise,
                    });
                } catch (err) {
                    console.error('❌ [Facebook] Erreur upload:', err.message);
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * POST /api/facebook/groups/:groupId/scrape-report
             * Le scraper confirme ici si la fenêtre de posts est entièrement couverte.
             * Un import partiel ne déclenche donc jamais le cooldown.
             */
            app.post('/api/facebook/groups/:groupId/scrape-report', async (req, res) => {
                try {
                    const { groupId } = req.params;
                    const { status, limit, postCount, oldestPostAt, newestPostAt, newestPostId } = req.body || {};
                    if (!['complete', 'incomplete'].includes(status)) {
                        return res.status(400).json({ error: 'status doit être complete ou incomplete' });
                    }
                    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : null;
                    const safePostCount = Number.isInteger(postCount) && postCount >= 0 ? postCount : 0;
                    const oldest = oldestPostAt && !Number.isNaN(new Date(oldestPostAt).getTime()) ? new Date(oldestPostAt) : null;
                    const newest = newestPostAt && !Number.isNaN(new Date(newestPostAt).getTime()) ? new Date(newestPostAt) : null;
                    const query = buildScrapeReportQuery({
                        status, groupId, oldest, newest,
                        newestPostId: newestPostId ? String(newestPostId) : null,
                        limit: safeLimit, postCount: safePostCount
                    });
                    const { rows } = await db.query(query.text, query.values);
                    if (rows.length === 0) return res.status(404).json({ error: 'Groupe introuvable' });
                    res.json({ success: true, group: rows[0] });
                } catch (err) {
                    console.error('❌ [Facebook] Erreur rapport de scraping:', err.message);
                    res.status(500).json({ error: err.message });
                }
            });

            // ── File d'enrichissement des galeries Facebook ────────────────
            // NestJS appelle enqueue après la validation admin. Le worker ne
            // reçoit qu'un job à la fois et ne peut donc pas concurrencer les
            // deux collecteurs de groupes ni partager leur profil Chrome.
            app.post('/api/facebook/media-enrichment/enqueue', requireFacebookMediaEnrichmentToken, async (req, res) => {
                try {
                    const propertyId = Number(req.body?.propertyId);
                    if (!Number.isInteger(propertyId) || propertyId <= 0) {
                        return res.status(400).json({ error: 'propertyId entier positif requis' });
                    }

                    const { rows: posts } = await db.query(`
                        SELECT post_id, post_url, image_urls
                        FROM facebook_posts
                        WHERE real_property_id = $1
                          AND post_url IS NOT NULL
                        ORDER BY updated_at DESC NULLS LAST, created_at DESC
                        LIMIT 1
                    `, [propertyId]);
                    if (posts.length === 0) {
                        return res.status(404).json({ error: 'Post Facebook source introuvable pour ce bien' });
                    }

                    const post = posts[0];
                    const { rows } = await db.query(`
                        INSERT INTO facebook_media_enrichment_jobs
                          (property_id, facebook_post_id, post_url, known_image_urls, status, next_attempt_at, updated_at)
                        VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW())
                        ON CONFLICT (property_id) DO UPDATE SET
                          facebook_post_id = EXCLUDED.facebook_post_id,
                          post_url = EXCLUDED.post_url,
                          known_image_urls = EXCLUDED.known_image_urls,
                          status = CASE
                            WHEN facebook_media_enrichment_jobs.status = 'completed' THEN 'completed'
                            ELSE 'pending'
                          END,
                          next_attempt_at = CASE
                            WHEN facebook_media_enrichment_jobs.status = 'completed' THEN facebook_media_enrichment_jobs.next_attempt_at
                            ELSE NOW()
                          END,
                          locked_at = CASE
                            WHEN facebook_media_enrichment_jobs.status = 'completed' THEN facebook_media_enrichment_jobs.locked_at
                            ELSE NULL
                          END,
                          last_error = CASE
                            WHEN facebook_media_enrichment_jobs.status = 'completed' THEN facebook_media_enrichment_jobs.last_error
                            ELSE NULL
                          END,
                          attempts = 0,
                          updated_at = NOW()
                        WHERE facebook_media_enrichment_jobs.status = 'failed'
                          AND $5::boolean
                        RETURNING id, property_id, facebook_post_id, status, attempts
                    `, [propertyId, post.post_id, post.post_url, JSON.stringify(post.image_urls || []), req.body?.retryFailed === true]);
                    res.status(202).json({ success: true, skipped: rows.length === 0, job: rows[0] || null });
                } catch (err) {
                    console.error('❌ [Facebook media] Impossible d’enfiler le job:', err.message);
                    res.status(500).json({ error: err.message });
                }
            });

            app.post('/api/facebook/media-enrichment/claim', requireFacebookMediaEnrichmentToken, async (_req, res) => {
                try {
                    // Un crash du worker ne bloque pas la file éternellement.
                    await db.query(`
                        UPDATE facebook_media_enrichment_jobs
                        SET status = 'pending', locked_at = NULL, next_attempt_at = NOW(),
                            last_error = COALESCE(last_error, 'Worker interrompu avant la fin'), updated_at = NOW()
                        WHERE status = 'processing' AND locked_at < NOW() - INTERVAL '30 minutes'
                    `);
                    const { rows } = await db.query(`
                        WITH candidate AS (
                          SELECT id
                          FROM facebook_media_enrichment_jobs
                          WHERE status = 'pending' AND next_attempt_at <= NOW()
                          ORDER BY created_at ASC
                          FOR UPDATE SKIP LOCKED
                          LIMIT 1
                        )
                        UPDATE facebook_media_enrichment_jobs job
                        SET status = 'processing', locked_at = NOW(), attempts = attempts + 1, updated_at = NOW()
                        FROM candidate
                        WHERE job.id = candidate.id
                        RETURNING job.id, job.property_id, job.facebook_post_id, job.post_url,
                                  job.known_image_urls, job.attempts
                    `);
                    res.json({ job: rows[0] || null });
                } catch (err) {
                    console.error('❌ [Facebook media] Impossible de réclamer un job:', err.message);
                    res.status(500).json({ error: err.message });
                }
            });

            app.post('/api/facebook/media-enrichment/jobs/:id/complete', requireFacebookMediaEnrichmentToken, async (req, res) => {
                try {
                    const jobId = Number(req.params.id);
                    const imageUrls = [...new Set((req.body?.imageUrls || []).filter(url => typeof url === 'string' && /^https:\/\//i.test(url)))];
                    if (!Number.isInteger(jobId) || jobId <= 0) {
                        return res.status(400).json({ error: 'Job valide requis' });
                    }
                    const { rows } = await db.query(`
                        SELECT * FROM facebook_media_enrichment_jobs WHERE id = $1 AND status = 'processing'
                    `, [jobId]);
                    if (rows.length === 0) return res.status(409).json({ error: 'Job absent ou non réclamé' });
                    const job = rows[0];
                    if (imageUrls.length > 0) {
                        // NESTJS_FACEBOOK_URL contient déjà `/properties`.
                        // Retirer seulement la route de création, sinon on
                        // construirait `/properties/properties/:id` (404).
                        const nestBase = (process.env.NESTJS_FACEBOOK_URL || 'http://nestjs_app:8000/properties/create-from-facebook')
                            .replace(/\/properties\/create-from-facebook\/?$/, '');
                        await axios.post(`${nestBase}/properties/${job.property_id}/facebook-enrichment-images`, {
                            image_urls: imageUrls,
                            facebook_post_id: job.facebook_post_id,
                        }, {
                            headers: { 'x-facebook-media-token': process.env.FACEBOOK_MEDIA_ENRICHMENT_TOKEN },
                            timeout: 120000,
                            maxContentLength: 100 * 1024 * 1024,
                            maxBodyLength: 100 * 1024 * 1024,
                        });
                    }
                    await db.query(`
                        UPDATE facebook_media_enrichment_jobs
                        SET status = 'completed', completed_at = NOW(), locked_at = NULL,
                            last_error = NULL, updated_at = NOW()
                        WHERE id = $1
                    `, [jobId]);
                    res.json({ success: true, imageCount: imageUrls.length });
                } catch (err) {
                    console.error('❌ [Facebook media] Finalisation impossible:', err.message);
                    res.status(502).json({ error: err.response?.data?.message || err.message });
                }
            });

            app.post('/api/facebook/media-enrichment/jobs/:id/fail', requireFacebookMediaEnrichmentToken, async (req, res) => {
                try {
                    const jobId = Number(req.params.id);
                    const error = String(req.body?.error || 'Extraction de galerie impossible').slice(0, 1000);
                    const browserUnavailable = req.body?.browserUnavailable === true;
                    const { rows } = await db.query(`
                        UPDATE facebook_media_enrichment_jobs
                        SET status = CASE WHEN $3::boolean THEN 'pending' WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
                            attempts = CASE WHEN $3::boolean THEN GREATEST(attempts - 1, 0) ELSE attempts END,
                            locked_at = NULL,
                            next_attempt_at = CASE WHEN $3::boolean THEN NOW() + INTERVAL '15 seconds' WHEN attempts >= 3 THEN next_attempt_at ELSE NOW() + INTERVAL '15 minutes' END,
                            last_error = $2, updated_at = NOW()
                        WHERE id = $1 AND status = 'processing'
                        RETURNING id, status, attempts
                    `, [jobId, error, browserUnavailable]);
                    if (rows.length === 0) return res.status(409).json({ error: 'Job absent ou non réclamé' });
                    res.json({ success: true, job: rows[0] });
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * GET /api/facebook/groups
             * Liste tous les groupes Facebook importés
             */
            app.get('/api/facebook/groups', async (req, res) => {
                const showAll = req.query.all === 'true';
                try {
                    let whereClause = '';
                    if (!showAll) {
                        whereClause = 'WHERE fg.is_validated IS NOT FALSE';
                    }

                    const { rows } = await db.query(`
                        SELECT fg.*,
                            COUNT(fp.id) AS total_posts,
                            COUNT(fp.id) FILTER (WHERE fp.is_processed = TRUE AND fp.analysis_error IS NULL) AS processed,
                            COUNT(fp.id) FILTER (WHERE fp.is_noise = TRUE OR (fp.is_processed = TRUE AND fp.analysis_error IS NOT NULL)) AS noise,
                            COUNT(fp.id) FILTER (WHERE fp.is_processed = FALSE AND fp.is_noise = FALSE AND fp.analysis_error IS NULL) AS pending,
                            COUNT(fp.id) FILTER (WHERE fp.analysis_error IS NOT NULL AND fp.is_noise = FALSE AND fp.is_processed = FALSE) AS errors,
                            MIN(fp.estimated_post_at) AS first_post_date,
                            COUNT(fp.id) FILTER (WHERE DATE(COALESCE(fp.estimated_post_at, fp.scraped_at, fp.created_at)) = CURRENT_DATE - INTERVAL '1 day') AS posts_yesterday,
                            COUNT(fp.id) FILTER (WHERE fp.is_processed = TRUE AND fp.analysis_error IS NULL AND DATE(COALESCE(fp.estimated_post_at, fp.scraped_at, fp.created_at)) = CURRENT_DATE - INTERVAL '1 day') AS processed_yesterday,
                            COALESCE(COUNT(fp.id) FILTER (WHERE fp.is_processed = TRUE AND fp.analysis_error IS NULL)::float / NULLIF(COUNT(DISTINCT DATE(COALESCE(fp.estimated_post_at, fp.scraped_at, fp.created_at))), 0), 0) AS daily_avg_posts,
                            COALESCE(COUNT(fp.id)::float / NULLIF(COUNT(DISTINCT DATE(COALESCE(fp.estimated_post_at, fp.scraped_at, fp.created_at))), 0), 0) AS daily_total_avg_posts
                        FROM facebook_groups fg
                        LEFT JOIN facebook_posts fp ON fp.group_id = fg.group_id
                        ${whereClause}
                        GROUP BY fg.id
                        ORDER BY fg.last_scraped_at DESC
                    `);
                    res.json(rows);
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * GET /api/facebook/groups/:groupId/scrape-info
             * Retourne les informations de continuation pour un groupe
             * Utilisé par l'extension pour savoir où reprendre le scraping
             */
            app.get('/api/facebook/groups/:groupId/scrape-info', async (req, res) => {
                try {
                    const { groupId } = req.params;

                    const result = await db.query(`
                        SELECT
                            fg.group_id,
                            fg.group_name,
                            fg.last_scraped_at,
                            COALESCE(MAX(fp.scraped_at), fg.most_recent_post_at) AS most_recent_post_at,
                            fg.is_validated,
                            fg.cooldown_hours,
                            fg.most_recent_post_id
                        FROM facebook_groups fg
                        LEFT JOIN facebook_posts fp ON fp.group_id = fg.group_id
                        WHERE fg.group_id = $1
                        GROUP BY fg.group_id, fg.group_name, fg.last_scraped_at, fg.most_recent_post_at, fg.is_validated, fg.cooldown_hours, fg.most_recent_post_id
                    `, [groupId]);

                    if (result.rows.length === 0) {
                        // Groupe jamais scrapé - retourner null pour lastScrapedAt
                        return res.json({
                            groupId,
                            lastScrapedAt: null,
                            most_recent_post_at: null,
                            most_recent_post_id: null,
                            mostRecentPostAt: null,
                            mostRecentPostId: null,
                            cooldownHours: 6,
                            isNewGroup: true
                        });
                    }

                    const group = result.rows[0];
                    // Ne jamais utiliser MAX(scraped_at) ici : un upload partiel
                    // aurait alors le droit de déplacer le checkpoint. Le watermark
                    // est celui du dernier rapport de couverture complet.
                    const watermark = group.most_recent_post_at || null;
                    res.json({
                        groupId: group.group_id,
                        groupName: group.group_name,
                        lastScrapedAt: watermark,
                        most_recent_post_at: watermark,
                        most_recent_post_id: group.most_recent_post_id || null,
                        mostRecentPostAt: watermark,
                        mostRecentPostId: group.most_recent_post_id || null,
                        cooldownHours: group.cooldown_hours || 6,
                        isValidated: group.is_validated,
                        isNewGroup: false
                    });
                } catch (error) {
                    console.error('[scrape-info] Error:', error);
                    res.status(500).json({ error: 'Erreur serveur' });
                }
            });

            /**
             * PATCH /api/facebook/groups/:groupId
             * Met à jour le nom et/ou le statut is_validated d'un groupe
             */
            app.patch('/api/facebook/groups/:groupId', async (req, res) => {
                try {
                    const { groupId } = req.params;
                    const { group_name, is_validated } = req.body;

                    const updates = [];
                    const params = [];

                    if (group_name !== undefined) {
                        params.push(group_name.trim());
                        updates.push(`group_name = $${params.length}`);
                    }
                    if (is_validated !== undefined) {
                        params.push(is_validated === null ? null : Boolean(is_validated));
                        updates.push(`is_validated = $${params.length}`);
                    }

                    if (updates.length === 0) {
                        return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
                    }

                    params.push(groupId);
                    const { rows } = await db.query(
                        `UPDATE facebook_groups SET ${updates.join(', ')} WHERE group_id = $${params.length} RETURNING *`,
                        params
                    );

                    if (rows.length === 0) return res.status(404).json({ error: 'Groupe introuvable.' });
                    res.json({ success: true, group: rows[0] });
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * DELETE /api/facebook/groups/:groupId
             * Supprime un groupe Facebook et tous ses posts
             */
            app.delete('/api/facebook/groups/:groupId', async (req, res) => {
                try {
                    const { groupId } = req.params;
                    // Les posts seront supprimés en cascade si la foreign key l'autorise.
                    // Sinon on les supprime d'abord manuellement.
                    await db.query('DELETE FROM facebook_posts WHERE group_id = $1', [groupId]);
                    const { rowCount } = await db.query('DELETE FROM facebook_groups WHERE group_id = $1', [groupId]);

                    if (rowCount === 0) return res.status(404).json({ error: 'Groupe introuvable.' });
                    res.json({ success: true, message: 'Groupe supprimé avec succès.' });
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            // /**
            //  * POST /api/facebook/groups
            //  * Ajoute un ou plusieurs nouveaux groupes Facebook
            //  */
            app.post('/api/facebook/groups', async (req, res) => {
                try {
                    let groupsInput = [];
                    if (Array.isArray(req.body)) {
                        groupsInput = req.body;
                    } else if (req.body.groups && Array.isArray(req.body.groups)) {
                        groupsInput = req.body.groups;
                    } else if (req.body) {
                        groupsInput = [req.body];
                    }

                    if (groupsInput.length === 0) {
                        return res.status(400).json({ error: "Aucun groupe fourni dans la requête" });
                    }

                    const insertedGroups = [];
                    const errors = [];

                    for (const group of groupsInput) {
                        let groupId = group.groupId || group.group_id;
                        let groupUrl = group.groupUrl || group.group_url;
                        let groupName = group.groupName || group.group_name;

                        // Tenter d'extraire depuis l'URL si l'ID est absent
                        if (!groupId && groupUrl) {
                            const urlStr = groupUrl.trim();
                            const match = urlStr.match(/\/groups\/([^\/]+)/);
                            if (match) {
                                groupId = match[1];
                            } else if (/^\d+$/.test(urlStr)) {
                                groupId = urlStr;
                            }
                        }

                        // Si on a un ID mais pas d'URL, on peut la reconstruire
                        if (groupId && !groupUrl) {
                            groupUrl = `https://www.facebook.com/groups/${groupId}/`;
                        }

                        if (!groupId) {
                            errors.push({ group, error: "Impossible de déterminer l'ID du groupe (group_id manquant et non-extractible de group_url)" });
                            continue;
                        }

                        if (!groupName) {
                            groupName = `Groupe Facebook ${groupId}`;
                        }

                        try {
                            // Vérifier si le groupe existe déjà
                            const existing = await db.query(
                                `SELECT group_id FROM facebook_groups WHERE group_id = $1`,
                                [groupId.trim()]
                            );

                            if (existing.rows.length > 0) {
                                errors.push({
                                    group,
                                    alreadyExists: true,
                                    error: `Le groupe "${groupId.trim()}" existe déjà dans la base de données.`
                                });
                                continue;
                            }

                            const { rows } = await db.query(`
                                INSERT INTO facebook_groups (group_id, group_url, group_name, last_scraped_at)
                                VALUES ($1, $2, $3, NULL)
                                RETURNING *
                            `, [groupId.trim(), groupUrl.trim(), groupName.trim()]);

                            insertedGroups.push(rows[0]);
                        } catch (dbErr) {
                            errors.push({ group, error: dbErr.message });
                        }
                    }

                    // Si tous les groupes existent déjà et aucun n'a été inséré
                    const allAlreadyExist = errors.length > 0 && insertedGroups.length === 0 && errors.every(e => e.alreadyExists);
                    if (allAlreadyExist) {
                        return res.status(409).json({
                            success: false,
                            error: errors.length === 1
                                ? errors[0].error
                                : `${errors.length} groupe(s) existent déjà dans la base de données.`,
                            groups: errors.map(e => ({ groupId: e.group.groupId || e.group.group_id, message: e.error }))
                        });
                    }

                    res.json({
                        success: true,
                        inserted: insertedGroups.length,
                        groups: insertedGroups,
                        errors: errors.length > 0 ? errors : undefined
                    });
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * GET /api/facebook/posts
             * Liste les posts Facebook avec filtres optionnels
             * Query params: group_id, status (pending|processed|noise|error), page, limit
             */
            app.get('/api/facebook/posts', async (req, res) => {
                try {
                    const { group_id, status, page = 1, limit = 50 } = req.query;
                    const offset = (parseInt(page) - 1) * parseInt(limit);

                    let whereClause = 'WHERE 1=1';
                    const params = [];

                    if (group_id) {
                        params.push(group_id);
                        whereClause += ` AND fp.group_id = $${params.length}`;
                    }
                    if (status === 'pending') {
                        whereClause += ' AND fp.is_processed = FALSE AND fp.is_noise = FALSE AND fp.analysis_error IS NULL';
                    } else if (status === 'processed') {
                        whereClause += ' AND fp.is_processed = TRUE';
                    } else if (status === 'noise') {
                        whereClause += ' AND fp.is_noise = TRUE';
                    } else if (status === 'error') {
                        whereClause += ' AND fp.analysis_error IS NOT NULL AND fp.is_noise = FALSE AND fp.is_processed = FALSE';
                    }

                    params.push(parseInt(limit), offset);

                    const { rows } = await db.query(`
                        SELECT fp.*, fg.group_name, fg.group_url
                        FROM facebook_posts fp
                        LEFT JOIN facebook_groups fg ON fp.group_id = fg.group_id
                        ${whereClause}
                        ORDER BY fp.scraped_at DESC
                        LIMIT $${params.length - 1} OFFSET $${params.length}
                    `, params);

                    // Comptage total
                    const countParams = params.slice(0, -2);
                    const { rows: countRows } = await db.query(`
                        SELECT COUNT(*) AS total FROM facebook_posts fp ${whereClause}
                    `, countParams);

                    res.json({
                        posts: rows,
                        total: parseInt(countRows[0].total),
                        page: parseInt(page),
                        limit: parseInt(limit),
                    });
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * POST /api/facebook/process-all
             * Lance le batch processing de TOUS les posts Facebook en attente (SSE)
             * Répond en Server-Sent Events pour le suivi en temps réel
             */
            app.get('/api/facebook/process-all', async (req, res) => {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

                try {
                    send({ type: 'start', message: '🚀 Début du traitement des posts Facebook...' });

                    const result = await processFacebookBatch(db, (progress) => send(progress));

                    send({
                        type: 'complete',
                        message: `✅ Terminé : ${result.success} biens créés, ${result.errors} erreurs, ${result.noise} bruits`,
                        ...result,
                    });
                    res.end();
                } catch (err) {
                    send({ type: 'error', message: err.message });
                    res.end();
                }
            });

            /**
             * POST /api/facebook/posts/:postId/retry
             * Relance le traitement d'un post spécifique (en erreur)
             */
            app.post('/api/facebook/posts/:postId/retry', async (req, res) => {
                try {
                    const { postId } = req.params;
                    const { rows } = await db.query(`
                        SELECT fp.*, fg.group_url, fg.group_name
                        FROM facebook_posts fp
                        LEFT JOIN facebook_groups fg ON fp.group_id = fg.group_id
                        WHERE fp.post_id = $1
                    `, [postId]);

                    if (rows.length === 0) {
                        return res.status(404).json({ error: 'Post introuvable' });
                    }

                    const post = rows[0];

                    // Réinitialiser l'erreur pour permettre le retry
                    await db.query(`
                        UPDATE facebook_posts
                        SET analysis_error = NULL, is_noise = FALSE, is_processed = FALSE, updated_at = NOW()
                        WHERE post_id = $1
                    `, [postId]);

                    // Réponse immédiate, traitement en arrière-plan
                    res.json({ success: true, message: 'Retry lancé en arrière-plan' });

                    processFacebookPost(post, db, { group_url: post.group_url, group_name: post.group_name })
                        .then(result => console.log(`🔄 [Facebook] Retry post ${postId}:`, result))
                        .catch(err => console.error(`❌ [Facebook] Retry post ${postId}:`, err.message));

                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * POST /api/facebook/posts/:postId/noise
             * Marque manuellement un post comme bruit (ignorer définitivement)
             */
            app.post('/api/facebook/posts/:postId/noise', async (req, res) => {
                try {
                    const { postId } = req.params;
                    await db.query(`
                        UPDATE facebook_posts
                        SET is_noise = TRUE, analysis_error = NULL, is_processed = FALSE, updated_at = NOW()
                        WHERE post_id = $1
                    `, [postId]);
                    res.json({ success: true, message: 'Post marqué comme bruit' });
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * GET /api/facebook/stats
             * Statistiques globales du pipeline Facebook
             */
            app.get('/api/facebook/stats', async (req, res) => {
                try {
                    const { rows } = await db.query(`
                        SELECT
                            COUNT(*) AS total,
                            COUNT(*) FILTER (WHERE is_processed = TRUE AND analysis_error IS NULL) AS processed,
                            COUNT(*) FILTER (WHERE is_noise = TRUE OR (is_processed = TRUE AND analysis_error IS NOT NULL)) AS noise,
                            COUNT(*) FILTER (WHERE is_processed = FALSE AND is_noise = FALSE AND analysis_error IS NULL) AS pending,
                            COUNT(*) FILTER (WHERE analysis_error IS NOT NULL AND is_noise = FALSE AND is_processed = FALSE) AS errors
                        FROM facebook_posts
                    `);
                    const gRows = (await db.query('SELECT COUNT(*) AS total FROM facebook_groups')).rows;
                    res.json({ ...rows[0], groups: parseInt(gRows[0].total) });
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * POST /api/facebook/groups/scrape-info-by-url
             * Alternative endpoint qui accepte une URL de groupe au lieu d'un ID
             */
            app.post('/api/facebook/groups/scrape-info-by-url', async (req, res) => {
                try {
                    const { groupUrl } = req.body;

                    if (!groupUrl) {
                        return res.status(400).json({ error: 'groupUrl requis' });
                    }

                    // Extraire group_id de l'URL
                    const groupIdMatch = groupUrl.match(/groups\/([^/?]+)/);
                    if (!groupIdMatch) {
                        return res.status(400).json({ error: 'URL de groupe Facebook invalide' });
                    }
                    const groupId = groupIdMatch[1];

                    const result = await db.query(`
                        SELECT
                            group_id,
                            group_name,
                            last_scraped_at,
                            most_recent_post_at,
                            most_recent_post_id,
                            cooldown_hours,
                            is_validated
                        FROM facebook_groups
                        WHERE group_id = $1
                    `, [groupId]);

                    if (result.rows.length === 0) {
                        return res.json({
                            groupId,
                            lastScrapedAt: null,
                            mostRecentPostAt: null,
                            mostRecentPostId: null,
                            cooldownHours: 12,
                            isNewGroup: true
                        });
                    }

                    const group = result.rows[0];
                    res.json({
                        groupId: group.group_id,
                        groupName: group.group_name,
                        lastScrapedAt: group.last_scraped_at,
                        mostRecentPostAt: group.most_recent_post_at,
                        mostRecentPostId: group.most_recent_post_id || null,
                        cooldownHours: group.cooldown_hours || 6,
                        isValidated: group.is_validated,
                        isNewGroup: false
                    });
                } catch (error) {
                    console.error('[scrape-info-by-url] Error:', error);
                    res.status(500).json({ error: 'Erreur serveur' });
                }
            });

            /**
             * GET /api/facebook/groups/:groupId/daily-stats
             * Statistiques journalières pour un groupe Facebook spécifique
             */
            app.get('/api/facebook/groups/:groupId/daily-stats', async (req, res) => {
                try {
                    const { groupId } = req.params;
                    const { rows } = await db.query(`
                        SELECT 
                            DATE(COALESCE(estimated_post_at, scraped_at, created_at)) as day,
                            COUNT(*) as post_count,
                            COUNT(*) FILTER (WHERE is_processed = TRUE AND analysis_error IS NULL) AS processed_count,
                            COUNT(*) FILTER (WHERE is_noise = TRUE OR (is_processed = TRUE AND analysis_error IS NOT NULL)) AS noise_count,
                            COUNT(*) FILTER (WHERE analysis_error IS NOT NULL AND is_noise = FALSE AND is_processed = FALSE) AS error_count
                        FROM facebook_posts
                        WHERE group_id = $1
                        GROUP BY DATE(COALESCE(estimated_post_at, scraped_at, created_at))
                        ORDER BY day DESC;
                    `, [groupId]);
                    res.json(rows);
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * GET /api/facebook/daily-analytics
             * Statistiques analytiques globales par jour pour le pipeline Facebook
             */
            app.get('/api/facebook/daily-analytics', async (req, res) => {
                try {
                    const { rows } = await db.query(`
                        WITH fb AS (
                            SELECT 
                                DATE(created_at) AS jour,
                                COUNT(id) AS total_posts_recuperes,
                                COUNT(id) FILTER (WHERE real_property_id IS NOT NULL AND analysis_error IS NULL) AS biens_crees_uniques,
                                COUNT(id) FILTER (WHERE analysis_error IN ('Doublon post-IA (Historique)', 'Doublon ignoré avant IA')) AS doublons,
                                COUNT(id) FILTER (
                                    WHERE real_property_id IS NULL 
                                    AND (analysis_error IN ('Bien de plus de 24h', 'Moins de 3 images attachées', 'Moins de 3 images accessibles', 'Recherche sans numéro de téléphone', 'Classé comme bruit avant IA (Vocabulaire manquant)', 'Doublon post-IA (Historique)', 'Doublon ignoré avant IA') OR analysis_error LIKE 'Mot interdit:%')
                                ) AS ecart_sans_analyse_ia,
                                COUNT(id) FILTER (
                                    WHERE real_property_id IS NULL 
                                    AND NOT (analysis_error IN ('Bien de plus de 24h', 'Moins de 3 images attachées', 'Moins de 3 images accessibles', 'Recherche sans numéro de téléphone', 'Classé comme bruit avant IA (Vocabulaire manquant)', 'Doublon post-IA (Historique)', 'Doublon ignoré avant IA') OR analysis_error LIKE 'Mot interdit:%')
                                    AND NOT (is_processed = FALSE AND is_noise = FALSE AND analysis_error IS NULL AND is_client_demand = FALSE)
                                ) AS ecart_avec_analyse_ia,
                                COUNT(id) FILTER (WHERE is_processed = FALSE AND is_noise = FALSE AND analysis_error IS NULL AND is_client_demand = FALSE) AS en_attente
                            FROM facebook_posts
                            GROUP BY DATE(created_at)
                        ),
                        wa AS (
                            SELECT 
                                DATE(TO_TIMESTAMP(timestamp)) as jour,
                                COUNT(DISTINCT property_group_id) as whatsapp_groups
                            FROM messages
                            WHERE property_group_id IS NOT NULL AND property_group_id != 'noise' AND property_group_id NOT LIKE 'real_prop_%'
                            GROUP BY DATE(TO_TIMESTAMP(timestamp))
                        )
                        SELECT 
                            COALESCE(fb.jour, wa.jour) AS jour,
                            COALESCE(fb.total_posts_recuperes, 0) AS total_posts_recuperes,
                            COALESCE(fb.biens_crees_uniques, 0) AS biens_crees_uniques,
                            COALESCE(fb.doublons, 0) AS doublons,
                            COALESCE(fb.ecart_sans_analyse_ia, 0) AS ecart_sans_analyse_ia,
                            COALESCE(fb.ecart_avec_analyse_ia, 0) AS ecart_avec_analyse_ia,
                            COALESCE(fb.en_attente, 0) AS en_attente,
                            COALESCE(wa.whatsapp_groups, 0) AS whatsapp_groups
                        FROM fb
                        FULL OUTER JOIN wa ON fb.jour = wa.jour
                        ORDER BY jour DESC;
                    `);
                    res.json(rows);
                } catch (err) {
                    res.status(500).json({ error: err.message });
                }
            });

            /**
             * GET /api/facebook/backfill-videos/stats
             * Statistiques sur les vidéos Facebook à récupérer (avant de lancer le backfill)
             */
            app.get('/api/facebook/backfill-videos/stats', async (req, res) => {
                try {
                    // 1. Appeler le backend pour récupérer les IDs des biens sans vidéo
                    const nestUrl = (process.env.NESTJS_FACEBOOK_URL || 'http://nestjs_app:8000/properties/create-from-facebook')
                        .replace('/create-from-facebook', '/scraper/facebook-missing-videos');

                    console.log(`📊 [Backfill Stats] Appel backend: ${nestUrl}`);
                    const backendResponse = await axios.get(nestUrl, { timeout: 30000 });
                    const propertyIds = backendResponse.data?.data?.property_ids || [];

                    console.log(`📊 [Backfill Stats] Backend a retourné ${propertyIds.length} biens ACTIFS Facebook sans vidéo`);

                    if (propertyIds.length === 0) {
                        return res.json({
                            success: true,
                            message: 'Aucun bien Facebook ACTIF sans vidéo trouvé',
                            stats: { total_biens_sans_video: 0, posts_avec_video: 0, posts_recuperables: [] }
                        });
                    }

                    // 2. Croiser avec facebook_posts pour voir combien ont des vidéos
                    const { rows } = await db.query(`
                        SELECT
                            fp.post_id,
                            fp.real_property_id,
                            fp.video_url,
                            fp.text,
                            fg.group_name
                        FROM facebook_posts fp
                        LEFT JOIN facebook_groups fg ON fp.group_id = fg.group_id
                        WHERE fp.real_property_id = ANY($1::int[])
                          AND fp.video_url IS NOT NULL
                          AND fp.video_url != ''
                    `, [propertyIds]);

                    res.json({
                        success: true,
                        stats: {
                            total_biens_sans_video: propertyIds.length,
                            posts_avec_video: rows.length,
                            posts_recuperables: rows.map(r => ({
                                post_id: r.post_id,
                                property_id: r.real_property_id,
                                video_url: r.video_url,
                                group_name: r.group_name,
                                text_preview: r.text?.substring(0, 100) + '...'
                            }))
                        }
                    });
                } catch (err) {
                    console.error(`❌ [Backfill Stats] Erreur:`, err.message);
                    res.status(500).json({ success: false, error: err.message });
                }
            });

            /**
             * POST /api/facebook/backfill-videos
             * Lance le backfill des vidéos Facebook pour les biens existants
             * Utilise Server-Sent Events pour envoyer la progression en temps réel
             */
            app.post('/api/facebook/backfill-videos', async (req, res) => {
                // Configuration SSE pour la progression
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                const sendEvent = (data) => {
                    res.write(`data: ${JSON.stringify(data)}\n\n`);
                };

                try {
                    // 1. Appeler le backend pour récupérer les IDs des biens sans vidéo
                    const nestUrl = (process.env.NESTJS_FACEBOOK_URL || 'http://nestjs_app:8000/properties/create-from-facebook')
                        .replace('/create-from-facebook', '/scraper/facebook-missing-videos');

                    sendEvent({ type: 'info', message: `Récupération des biens ACTIFS Facebook sans vidéo depuis le backend...` });
                    console.log(`🎬 [Backfill Videos] Appel backend: ${nestUrl}`);

                    const backendResponse = await axios.get(nestUrl, { timeout: 30000 });
                    const propertyIds = backendResponse.data?.data?.property_ids || [];

                    console.log(`🎬 [Backfill Videos] Backend a retourné ${propertyIds.length} biens ACTIFS Facebook sans vidéo`);

                    if (propertyIds.length === 0) {
                        sendEvent({ type: 'complete', message: 'Aucun bien Facebook ACTIF sans vidéo trouvé', stats: { success: 0, errors: 0, total: 0 } });
                        console.log(`🎬 [Backfill Videos] Terminé — aucun bien à traiter`);
                        return res.end();
                    }

                    sendEvent({ type: 'info', message: `${propertyIds.length} biens ACTIFS Facebook sans vidéo trouvés` });

                    // 2. Récupérer les posts Facebook correspondants avec vidéo
                    const { rows: posts } = await db.query(`
                        SELECT
                            fp.post_id,
                            fp.real_property_id,
                            fp.video_url,
                            fg.group_name
                        FROM facebook_posts fp
                        LEFT JOIN facebook_groups fg ON fp.group_id = fg.group_id
                        WHERE fp.real_property_id = ANY($1::int[])
                          AND fp.video_url IS NOT NULL
                          AND fp.video_url != ''
                    `, [propertyIds]);

                    if (posts.length === 0) {
                        sendEvent({ type: 'complete', message: 'Aucun post Facebook avec vidéo trouvé pour ces biens ACTIFS', stats: { success: 0, errors: 0, total: 0 } });
                        console.log(`🎬 [Backfill Videos] Terminé — aucun post avec vidéo trouvé dans la BDD scraper`);
                        return res.end();
                    }

                    console.log(`🎬 [Backfill Videos] ${posts.length} posts avec vidéo trouvés, début du traitement...`);
                    sendEvent({ type: 'info', message: `${posts.length} posts avec vidéo à traiter pour des biens ACTIFS` });

                    // 3. Traiter chaque post
                    let success = 0, errors = 0;
                    const patchUrl = (process.env.NESTJS_FACEBOOK_URL || 'http://nestjs_app:8000/properties/create-from-facebook')
                        .replace('/create-from-facebook', '');

                    for (let i = 0; i < posts.length; i++) {
                        const post = posts[i];
                        console.log(`🎬 [Backfill Videos] [${i + 1}/${posts.length}] Traitement bien #${post.real_property_id} (post ${post.post_id})...`);
                        sendEvent({
                            type: 'progress',
                            current: i + 1,
                            total: posts.length,
                            message: `Traitement du bien ACTIF #${post.real_property_id}...`
                        });

                        try {
                            // a. Télécharger et uploader la vidéo sur Bunny
                            console.log(`🎬 [Backfill Videos] [${i + 1}/${posts.length}] Téléchargement vidéo: ${post.video_url.substring(0, 60)}...`);
                            const { processVideoForBunny } = require('./facebook-processor');
                            const videoResult = await processVideoForBunny(post.video_url, post.post_id);

                            if (!videoResult) {
                                console.log(`❌ [Backfill Videos] [${i + 1}/${posts.length}] Échec upload vidéo pour bien #${post.real_property_id}`);
                                sendEvent({ type: 'error', message: `Échec upload vidéo pour bien #${post.real_property_id}` });
                                errors++;
                                continue;
                            }

                            // b. Appeler PATCH /properties/scraper/update-video/:id
                            console.log(`🎬 [Backfill Videos] [${i + 1}/${posts.length}] PATCH ${patchUrl}/scraper/update-video/${post.real_property_id}`);
                            const patchResponse = await axios.patch(
                                `${patchUrl}/scraper/update-video/${post.real_property_id}`,
                                { video_url: videoResult.url },
                                { timeout: 30000 }
                            );

                            if (patchResponse.data?.success) {
                                console.log(`✅ [Backfill Videos] [${i + 1}/${posts.length}] Bien #${post.real_property_id} mis à jour avec vidéo`);
                                sendEvent({
                                    type: 'success',
                                    message: `✅ Bien ACTIF #${post.real_property_id} mis à jour avec vidéo`,
                                    property_id: post.real_property_id,
                                    video_url: videoResult.url
                                });
                                success++;
                            } else {
                                console.log(`❌ [Backfill Videos] [${i + 1}/${posts.length}] Échec PATCH pour bien #${post.real_property_id}: ${patchResponse.data?.error}`);
                                sendEvent({ type: 'error', message: `Échec PATCH pour bien #${post.real_property_id}: ${patchResponse.data?.error}` });
                                errors++;
                            }
                        } catch (err) {
                            console.log(`❌ [Backfill Videos] [${i + 1}/${posts.length}] Erreur bien #${post.real_property_id}: ${err.message}`);
                            sendEvent({ type: 'error', message: `Erreur bien #${post.real_property_id}: ${err.message}` });
                            errors++;
                        }

                        // Pause de 3s entre chaque pour ne pas surcharger
                        await new Promise(r => setTimeout(r, 3000));
                    }

                    console.log(`🎬 [Backfill Videos] ========== TERMINÉ ==========`);
                    console.log(`🎬 [Backfill Videos] Succès: ${success} | Erreurs: ${errors} | Total: ${posts.length}`);
                    sendEvent({
                        type: 'complete',
                        message: `Backfill terminé: ${success} succès, ${errors} erreurs sur ${posts.length} biens ACTIFS`,
                        stats: { success, errors, total: posts.length }
                    });
                    res.end();

                } catch (err) {
                    console.error(`❌ [Backfill Videos] Erreur:`, err.message);
                    sendEvent({ type: 'fatal', error: err.message });
                    res.end();
                }
            });

            // ═══════════════════════════════════════════════════════════════

            // ═══════════════════════════════════════════════════════════════
            // 🤖 CRON AUTO FACEBOOK : Vérification toutes les 2 minutes
            // Lance processFacebookBatch si des posts sont en "pending"
            // ═══════════════════════════════════════════════════════════════
            let isFacebookProcessing = false;

            async function autoProcessFacebookPending() {
                if (isFacebookProcessing) {
                    console.log('⏭️ [Facebook Cron] Traitement déjà en cours, skip.');
                    return;
                }

                try {
                    // Vérifier s'il y a des posts pending
                    const { rows } = await db.query(`
                        SELECT COUNT(*) AS pending_count
                        FROM facebook_posts
                        WHERE is_processed = FALSE
                          AND is_noise = FALSE
                          AND analysis_error IS NULL
                    `);

                    const pendingCount = parseInt(rows[0].pending_count);

                    if (pendingCount === 0) {
                        console.log('✅ [Facebook Cron] Aucun post en attente. Rien à faire.');
                        return;
                    }

                    console.log(`🚀 [Facebook Cron] ${pendingCount} post(s) en attente détecté(s). Lancement du traitement...`);
                    isFacebookProcessing = true;

                    const result = await processFacebookBatch(db);
                    console.log(`✅ [Facebook Cron] Traitement terminé : ${result.success} succès, ${result.errors} erreurs, ${result.noise} bruits.`);

                } catch (err) {
                    console.error('❌ [Facebook Cron] Erreur lors du traitement automatique:', err.message);
                } finally {
                    isFacebookProcessing = false;
                }
            }

            // Lancement initial après 30 secondes (laisser le serveur se stabiliser)
            setTimeout(() => {
                autoProcessFacebookPending().catch(e => console.error('❌ [Facebook Cron] Init error:', e.message));
            }, 30 * 1000);

            // Puis toutes les 2 minutes
            setInterval(() => {
                autoProcessFacebookPending().catch(e => console.error('❌ [Facebook Cron] Interval error:', e.message));
            }, 2 * 60 * 1000);

            console.log('🤖 [Facebook Cron] Activé — vérification automatique toutes les 2 minutes.');
            // ═══════════════════════════════════════════════════════════════

            // ═══════════════════════════════════════════════════════════════
            // La création automatique de biens est volontairement désactivée par défaut.
            // L'archivage WhatsApp reste immédiat, mais créer un bien est une action
            // métier irréversible qui doit être validée dans l'interface.
            console.log('🤖 [WhatsApp Cron] Workflow automatique:', process.env.AUTO_PROPERTY_WORKFLOW === 'true' ? 'activé' : 'désactivé (mode sûr)');
            const globalWorkflow = app.get('globalAutomatedWorkflow');
            if (globalWorkflow && process.env.AUTO_PROPERTY_WORKFLOW === 'true') {
                setTimeout(() => {
                    globalWorkflow().catch(e => console.error("❌ Error initial workflow:", e));
                }, 60 * 1000);

                setInterval(() => {
                    globalWorkflow().catch(err => console.error("❌ Erreur workflow automatisé:", err));
                }, 2 * 60 * 1000);
            }
            // ═══════════════════════════════════════════════════════════════

            // ── Recalcul initial des Tiers de scraping (au démarrage) ───────
            // Puis recalcul automatique toutes les semaines (7 jours)
            console.log('🔄 [Tiers] Recalcul initial des cooldowns de scraping...');
            recalculateTiers(db).catch(e => console.error('❌ [Tiers] Erreur recalcul initial:', e));
            setInterval(() => {
                console.log('🔄 [Tiers] Recalcul hebdomadaire des cooldowns de scraping...');
                recalculateTiers(db).catch(e => console.error('❌ [Tiers] Erreur recalcul hebdomadaire:', e));
            }, 7 * 24 * 60 * 60 * 1000); // 7 jours
            // ═══════════════════════════════════════════════════════════════



            return true;
        } catch (err) {
            console.log(`⚠️ En attente de PostgreSQL... Postgres est peut-être en train de démarrer (tentative ${i + 1}/${retries}).`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
    console.error('❌ Impossible de se connecter à PostgreSQL. L\'erreur ECONNREFUSED persiste.');
    return false;
}
const databaseReady = connectToDbWithRetry();

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
    authStrategy: new LocalAuth({
        dataPath: process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth',
        clientId: process.env.WWEBJS_CLIENT_ID || undefined
    }),
    puppeteer: puppeteerOptions
});
let reconnectTimer = null;

function scheduleWhatsAppReconnect() {
    if (process.env.WHATSAPP_ENABLED === 'false' || reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
            currentQR = null;
            setBotStatus('STARTING');
            await client.initialize();
        } catch (error) {
            console.error(`❌ Reconnexion WhatsApp impossible: ${error.message}`);
            setBotStatus('ERROR', { reason: error.message });
        }
    }, 5000);
}

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('NOUVEAU QR CODE : Scannez ce QR avec votre application WhatsApp.');
    currentQR = qr;
    setBotStatus('QR');
});

client.on('ready', () => {
    console.log('✅ C\'est connecté ! Le client est prêt et écoute les messages !');
    currentQR = null;
    setBotStatus('CONNECTED');
});

client.on('authenticated', () => {
    console.log('--- AUTHENTICATED: Chargement de la session en cours ---');
    setBotStatus('AUTHENTICATED');
});

client.on('auth_failure', (error) => {
    console.error('❌ Échec de l\'authentification !');
    currentQR = null;
    setBotStatus('ERROR', { reason: error || 'Échec de l’authentification' });
    scheduleWhatsAppReconnect();
});

client.on('disconnected', (reason) => {
    console.log('❌ Client déconnecté. Veuillez scanner à nouveau !');
    if (whatsappHistorySyncTimer) {
        clearInterval(whatsappHistorySyncTimer);
        whatsappHistorySyncTimer = null;
    }
    currentQR = null;
    setBotStatus('DISCONNECTED', { reason });
    sendErrorAlert('Bot DISCONNECTED', 'Le collecteur WhatsApp a été déconnecté. Une reconnexion et un nouveau scan peuvent être nécessaires.');
    scheduleWhatsAppReconnect();
});

function safeFilePart(value) {
    return String(value || 'message').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180);
}

function extensionFromMimeType(mimeType) {
    const subtype = String(mimeType || '').split('/')[1]?.split(/[+;]/)[0]?.toLowerCase();
    const extensions = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', mp4: 'mp4', mpeg: 'mpeg', ogg: 'ogg', opus: 'opus', pdf: 'pdf', plain: 'txt' };
    return extensions[subtype] || (subtype && /^[a-z0-9]{1,10}$/.test(subtype) ? subtype : 'bin');
}

async function downloadWhatsAppMedia(message, messageId) {
    if (!message.hasMedia) return { mediaPath: null, mediaMimeType: null };
    try {
        const media = await message.downloadMedia();
        if (!media?.data) return { mediaPath: null, mediaMimeType: media?.mimetype || null };
        const mediaDir = path.join(__dirname, 'media');
        await fs.promises.mkdir(mediaDir, { recursive: true });
        const mimeType = media.mimetype || 'application/octet-stream';
        const fileName = `${safeFilePart(messageId)}.${extensionFromMimeType(mimeType)}`;
        const localFilePath = path.join(mediaDir, fileName);
        if (!fs.existsSync(localFilePath)) {
            await fs.promises.writeFile(localFilePath, Buffer.from(media.data, 'base64'));
        }
        return { mediaPath: `media/${fileName}`, mediaMimeType: mimeType };
    } catch (error) {
        // Le texte est tout de même archivé lorsque WhatsApp ne permet pas le téléchargement.
        console.warn(`⚠️ Média non téléchargé (${messageId}): ${error.message}`);
        return { mediaPath: null, mediaMimeType: null };
    }
}

async function applyPropertyGrouping(messageData, messageRowId) {
    if (messageData.isFromMe || !messageData.hasMedia || !messageRowId) return;
    const isVisualMedia = messageData.mediaMimeType?.startsWith('image/') || messageData.mediaMimeType?.startsWith('video/');
    if (!isVisualMedia) return;
    if (messageData.body && messageData.body.length > 100) {
        await db.query('UPDATE messages SET property_group_id = $1 WHERE id = $2', [`auto_prop_self_${messageRowId}`, messageRowId]);
        return;
    }
    const { rows } = await db.query(`
        SELECT id, body, property_group_id, timestamp, has_media, real_property_id
        FROM messages
        WHERE chat_id = $1 AND sender_id = $2 AND id < $3
        ORDER BY timestamp DESC, id DESC LIMIT 1
    `, [messageData.chatId, messageData.senderId, messageRowId]);
    const previous = rows[0];
    if (!previous || previous.real_property_id || messageData.timestamp - previous.timestamp >= 420) return;
    const previousIsTextParent = previous.body && previous.body.length > 100 && !previous.has_media;
    const currentIsMediaChild = !messageData.body || messageData.body.length < 40;
    if (previousIsTextParent && currentIsMediaChild) {
        const groupId = previous.property_group_id || `auto_prop_parent_${previous.id}`;
        await db.query('UPDATE messages SET property_group_id = $1 WHERE id IN ($2, $3)', [groupId, previous.id, messageRowId]);
    } else if (previous.property_group_id?.startsWith('auto_prop_parent_') && currentIsMediaChild) {
        await db.query('UPDATE messages SET property_group_id = $1 WHERE id = $2', [previous.property_group_id, messageRowId]);
    }
}

async function archiveWhatsAppMessage(message) {
    const messageId = message.id?._serialized;
    if (!messageId || message.isStatus) return;
    const chat = await message.getChat();
    const chatId = chat?.id?._serialized;
    if (!chatId || chatId === 'status@broadcast') return;

    const isFromMe = Boolean(message.fromMe);
    const isGroup = Boolean(chat.isGroup);
    const senderId = message.author || (isFromMe ? client.info?.wid?._serialized : message.from) || chatId;
    let sender = null;
    try { sender = await client.getContactById(senderId); } catch (_) { /* LID non résolu : conserver l'identifiant exact. */ }
    const senderNumber = sender?.number || (/@(c\.us|s\.whatsapp\.net)$/.test(senderId) ? senderId.split('@')[0] : null);
    const senderName = sender?.pushname || sender?.name || sender?.shortName || senderNumber || 'Inconnu';
    const chatName = chat.name || chat.formattedTitle || (isGroup ? 'Groupe WhatsApp' : senderName);
    const timestamp = Number(message.timestamp) || Math.floor(Date.now() / 1000);
    const { mediaPath, mediaMimeType } = await downloadWhatsAppMedia(message, messageId);
    const messageData = {
        messageId,
        body: message.body || '',
        timestamp,
        isFromMe,
        isGroup,
        chatId,
        chatName,
        senderId,
        senderName,
        senderNumber,
        receiverId: message.to || null,
        hasMedia: Boolean(message.hasMedia),
        mediaPath,
        mediaMimeType,
        messageType: message.type || 'unknown',
        deviceType: message.deviceType || null,
        rawData: {
            id: messageId, from: message.from, to: message.to, author: message.author,
            fromMe: isFromMe, timestamp, type: message.type, hasMedia: Boolean(message.hasMedia)
        }
    };

    await db.query(`
        INSERT INTO chats (whatsapp_chat_id, chat_name, is_group, last_message_timestamp)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (whatsapp_chat_id) DO UPDATE SET
            chat_name = COALESCE(NULLIF(EXCLUDED.chat_name, ''), chats.chat_name),
            is_group = EXCLUDED.is_group,
            last_message_timestamp = GREATEST(COALESCE(chats.last_message_timestamp, 0), EXCLUDED.last_message_timestamp),
            updated_at = CURRENT_TIMESTAMP
    `, [messageData.chatId, messageData.chatName, messageData.isGroup, messageData.timestamp]);
    const { rows } = await db.query(`
        INSERT INTO messages (
            message_id, body, timestamp, is_from_me, is_group, chat_id, chat_name,
            sender_id, sender_name, sender_number, receiver_id, has_media, message_type, device_type,
            media_path, media_mime_type, raw_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (message_id) DO UPDATE SET
            body = EXCLUDED.body,
            sender_name = COALESCE(NULLIF(EXCLUDED.sender_name, ''), messages.sender_name),
            sender_number = COALESCE(EXCLUDED.sender_number, messages.sender_number),
            media_path = COALESCE(messages.media_path, EXCLUDED.media_path),
            media_mime_type = COALESCE(messages.media_mime_type, EXCLUDED.media_mime_type),
            raw_data = EXCLUDED.raw_data
        RETURNING id
    `, [
        messageData.messageId, messageData.body, messageData.timestamp, messageData.isFromMe,
        messageData.isGroup, messageData.chatId, messageData.chatName, messageData.senderId,
        messageData.senderName, messageData.senderNumber, messageData.receiverId,
        messageData.hasMedia, messageData.messageType, messageData.deviceType,
        messageData.mediaPath, messageData.mediaMimeType, messageData.rawData
    ]);
    const messageRowId = rows[0]?.id;
    await applyPropertyGrouping(messageData, messageRowId);
    broadcastRealtimeEvent('whatsapp_message', {
        chatId: messageData.chatId, messageId: messageData.messageId, rowId: messageRowId, isFromMe
    });
    console.log(`💾 Message WhatsApp archivé : ${messageData.messageId}`);
}

// whatsapp-web.js émet `message_create` pour tout nouveau message et `message`
// pour les entrants. On écoute les deux afin de couvrir les messages privés, de
// groupe et ceux écrits depuis le téléphone connecté, sans jamais en envoyer.
const messagesBeingArchived = new Set();

async function archiveWhatsAppEvent(message, source) {
    const messageId = message?.id?._serialized;
    if (!messageId || messagesBeingArchived.has(messageId)) return;

    messagesBeingArchived.add(messageId);
    console.log(`📨 [WhatsApp:${source}] Message détecté : ${messageId}`);
    try {
        await archiveWhatsAppMessage(message);
    } catch (error) {
        console.error(`❌ Archivage WhatsApp impossible: ${error.message}`);
    } finally {
        messagesBeingArchived.delete(messageId);
    }
}

client.on('message', message => archiveWhatsAppEvent(message, 'message'));
client.on('message_create', message => archiveWhatsAppEvent(message, 'message_create'));

function portoNovoTodayStartUnix() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Porto-Novo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const value = (type) => parts.find(part => part.type === type)?.value;
    // Porto-Novo est en UTC+1 toute l'année.
    return Math.floor(Date.parse(`${value('year')}-${value('month')}-${value('day')}T00:00:00+01:00`) / 1000);
}

// Filet de sécurité en lecture seule : WhatsApp Web peut occasionnellement ne
// pas relayer un événement temps réel depuis le téléphone principal. Cette
// synchronisation récupère alors les messages récents des discussions actives,
// sans utiliser d'API d'envoi ni écrire quoi que ce soit dans WhatsApp.
async function syncRecentWhatsAppHistory() {
    if (whatsappHistorySyncInProgress || !client.info) return;
    whatsappHistorySyncInProgress = true;
    try {
        const todayStart = portoNovoTodayStartUnix();
        // Ne pas appeler client.getChats() ici : la sérialisation complète d'un
        // seul groupe défectueux peut faire échouer toutes les conversations.
        const chatSummaries = await client.pupPage.evaluate(() => {
            return window.require('WAWebCollections').Chat.getModelsArray().map(chat => ({
                id: chat.id?._serialized,
                timestamp: Number(chat.t || chat.timestamp || 0)
            }));
        });
        const activeChats = chatSummaries.filter(chat => {
            const chatId = chat.id;
            const timestamp = Number(chat.timestamp) || 0;
            const previousTimestamp = syncedWhatsAppChatTimestamps.get(chatId);
            return chatId && timestamp >= todayStart && (previousTimestamp === undefined || timestamp > previousTimestamp);
        });

        for (const chatSummary of activeChats) {
            const chatId = chatSummary.id;
            const timestamp = Number(chatSummary.timestamp) || 0;
            try {
                const chat = await client.getChatById(chatId);
                if (!chat) continue;
                const recentMessages = await chat.fetchMessages({ limit: 50 });
                for (const message of recentMessages) {
                    if ((Number(message.timestamp) || 0) >= todayStart) {
                        await archiveWhatsAppEvent(message, 'history_sync');
                    }
                }
                syncedWhatsAppChatTimestamps.set(chatId, timestamp);
            } catch (error) {
                console.error(`⚠️ Synchronisation de ${chatId} impossible: ${error.message}`);
            }
        }

        if (activeChats.length > 0) {
            console.log(`🔄 [WhatsApp] Synchronisation de secours : ${activeChats.length} conversation(s) active(s).`);
        }
    } catch (error) {
        console.error('⚠️ Synchronisation WhatsApp impossible:', error?.stack || error?.message || error);
    } finally {
        whatsappHistorySyncInProgress = false;
    }
}

function startWhatsAppHistorySync() {
    if (whatsappHistorySyncTimer) return;
    syncRecentWhatsAppHistory();
    whatsappHistorySyncTimer = setInterval(syncRecentWhatsAppHistory, 30 * 1000);
}

client.on('ready', () => {
    startWhatsAppHistorySync();
});


(async () => {
    const databaseIsReady = await databaseReady;
    if (!databaseIsReady) {
        setBotStatus('ERROR', { reason: 'PostgreSQL indisponible : le collecteur ne peut pas archiver les messages.' });
        return;
    }
    if (process.env.WHATSAPP_ENABLED === 'false') {
        console.log('⏸️  [WhatsApp] Désactivé explicitement via WHATSAPP_ENABLED=false.');
        setBotStatus('DISCONNECTED', { reason: 'Collecteur désactivé par configuration.' });
        return;
    }

    const maxRetries = 10;

    // 🧹 Nettoyer les fichiers de verrou Chrome au démarrage
    // Ces fichiers sont laissés par un ancien processus Chrome après un crash/redémarrage
    function cleanChromeLocks() {
        const sessionDir = './.wwebjs_auth/session';
        const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        for (const lockFile of lockFiles) {
            const lockPath = `${sessionDir}/${lockFile}`;
            try {
                if (fs.existsSync(lockPath)) {
                    fs.unlinkSync(lockPath);
                    console.log(`🧹 [WhatsApp] Fichier verrou supprimé : ${lockFile}`);
                }
            } catch (e) {
                console.warn(`⚠️ [WhatsApp] Impossible de supprimer ${lockFile} : ${e.message}`);
            }
        }
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Nettoyage du verrou avant chaque tentative
            cleanChromeLocks();

            setBotStatus('STARTING');
            console.log(`🔄 Tentative d'initialisation WhatsApp (${attempt}/${maxRetries})...`);
            await client.initialize();
            break;
        } catch (err) {
            console.error(`❌ Echec tentative ${attempt}: ${err.message}`);

            // Si c'est une erreur de lock, on nettoie immédiatement avant la prochaine tentative
            if (err.message.includes('already running') || err.message.includes('SingletonLock')) {
                console.log('🧹 [WhatsApp] Détection de verrou Chrome — nettoyage forcé...');
                cleanChromeLocks();
            }

            if (attempt < maxRetries) {
                console.log(`⏳ Nouvelle tentative dans 5 secondes...`);
                await new Promise(r => setTimeout(r, 5000));
            } else {
                console.error('❌ Toutes les tentatives WhatsApp ont échoué. Le serveur reste disponible.');
                setBotStatus('ERROR', { reason: err.message });
            }
        }
    }
})();
