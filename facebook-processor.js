/**
 * facebook-processor.js
 * Pipeline de traitement des posts Facebook (Apify JSON)
 * Logique similaire au bot WhatsApp, adaptée pour les posts Facebook.
 */

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// --- CONFIGURATION ALERTE MAIL FACEBOOK ---
const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.MAIL_PORT) || 465,
    secure: true,
    auth: {
        user: process.env.MAIL_USERNAME,
        pass: process.env.MAIL_PASSWORD,
    },
});

let lastAiAlertTime = 0; // Anti-spam 1h

// ─── MOTS INTERDITS (même liste que WhatsApp) ───────────────────────────────
const FORBIDDEN_KEYWORDS = [
  'vendre', 'vente', 'parcelle', 'terrain', 'titre foncier',
  ' tf ', '\ntf\n', 'domaine',
];

// Mots-clés indiquant qu'un client recherche un bien
const CLIENT_SEARCH_KEYWORDS = [
  'recherche', 'cherche', 'besoin'
];

// ─── REGEX TÉLÉPHONE BÉNINOIS ────────────────────────────────────────────────
// Formats : 01 66 84 36 45 / 0190780657 / 96428419 / +229 01 96 23 95 85
const PHONE_REGEX = /(?:\+?229[\s]?)?(?:0[0-9][\s.]?[0-9]{2}[\s.]?[0-9]{2}[\s.]?[0-9]{2}[\s.]?[0-9]{2}|[0-9]{8})/g;

/**
 * Normalise le texte (unicode stylisé → ASCII, accents → base, minuscules)
 */
function normalizeText(text) {
  if (!text) return '';
  const result = Array.from(text).map(char => {
    const cp = char.codePointAt(0);
    if (cp >= 0x1D400 && cp <= 0x1D7FF) {
      if (cp >= 0x1D400 && cp <= 0x1D419) return String.fromCodePoint(cp - 0x1D400 + 0x41);
      if (cp >= 0x1D41A && cp <= 0x1D433) return String.fromCodePoint(cp - 0x1D41A + 0x61);
      if (cp >= 0x1D434 && cp <= 0x1D44D) return String.fromCodePoint(cp - 0x1D434 + 0x41);
      if (cp >= 0x1D44E && cp <= 0x1D467) return String.fromCodePoint(cp - 0x1D44E + 0x61);
      if (cp >= 0x1D7CE && cp <= 0x1D7D7) return String.fromCodePoint(cp - 0x1D7CE + 0x30);
    }
    return char;
  }).join('');
  return result.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Vérifie si le texte contient un mot interdit
 */
function containsForbiddenKeyword(text) {
  const normalized = normalizeText(text);
  return FORBIDDEN_KEYWORDS.find(kw => normalized.includes(kw)) || null;
}

/**
 * Extrait le premier numéro de téléphone béninois du texte
 * Retourne le numéro nettoyé (chiffres uniquement, avec +229 si présent) ou null
 */
function extractPhone(text) {
  if (!text) return null;
  const matches = text.match(PHONE_REGEX);
  if (!matches || matches.length === 0) return null;

  // Prendre le premier match, nettoyer les espaces/points
  const raw = matches[0].replace(/[\s.]/g, '');

  // Valider la longueur (8 chiffres béninois ou 10 avec préfixe 01/02/...)
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 13) return null;

  // Normaliser avec +229 si pas déjà là
  if (raw.startsWith('+229')) return raw;
  if (raw.startsWith('229')) return '+' + raw;
  return raw;
}

/**
 * Parse le timestamp relatif Facebook ("1m", "13m", "1h", "2h", "1d")
 * et retourne une date absolue à partir de scrapedAt
 */
function parseRelativeTimestamp(scrapedAt, relative) {
  const base = new Date(scrapedAt);
  if (!relative || typeof relative !== 'string') return base;

  const match = relative.trim().match(/^(\d+)\s*(m|h|d|s)$/i);
  if (!match) return base;

  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const msMap = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return new Date(base.getTime() - val * (msMap[unit] || 0));
}

/**
 * Extrait l'ID du groupe Facebook depuis postUrl ou postId
 * ex: /groups/450499635714727/posts/... → "450499635714727"
 */
function extractGroupId(post) {
  const url = post.postUrl || post.postId || '';
  const match = url.match(/\/groups\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Télécharge une image depuis une URL et retourne le buffer base64
 * Retourne null si échec (URL expirée, erreur réseau, etc.)
 */
async function downloadImageAsBase64(url, timeoutMs = 15000) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Locapay-Bot/1.0)',
      },
    });

    const mimeType = response.headers['content-type'] || 'image/jpeg';
    const extension = mimeType.split('/')[1]?.split(';')[0] || 'jpg';
    const data = Buffer.from(response.data).toString('base64');

    return { data, mimeType, extension };
  } catch (err) {
    console.warn(`⚠️ [Facebook] Échec téléchargement image: ${url.substring(0, 80)}... — ${err.message}`);
    return null;
  }
}

/**
 * Appel OpenRouter (DeepSeek) pour extraction des données du post
 * (même prompt que le bot WhatsApp, adapté Facebook)
 */
async function extractPropertyDataWithAI(description) {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const AI_MODEL = process.env.AI_MODEL || 'deepseek/deepseek-chat';

  if (!OPENROUTER_API_KEY) {
    console.error('❌ [Facebook] OPENROUTER_API_KEY manquante');
    return null;
  }

  // Normalisation des prix avant envoi (gestion de "mille", "milles", "mil", "k")
  const normalized = (description || '').replace(/(\d+)[.,]?(\d*)\s*(milles?|mil|k)\b/gi, (_, int, dec, unit) => {
    return String(Math.round(parseFloat(int + (dec ? '.' + dec : '')) * 1000));
  });

  const prompt = `
Tu es un expert en analyse immobilière. Analyse la description suivante et extrait les informations selon les champs spécifiés (JSON uniquement).

⚠️ RÈGLES CRITIQUES :
1. NE JAMAIS INVENTER d'informations. Si une info n'est pas mentionnée, retourne null.
2. PRIORITÉ TYPE : Si un texte mentionne un usage commercial (boutique, magasin, ou bureau), ce type est PRIORITAIRE.
3. TYPES : "Magasin" -> STORE, "Boutique" -> SHOP, "Bureau" -> OFFICE.
4. TÉLÉPHONE : Extrait le numéro de téléphone du propriétaire/agent du texte dans "manager_phone". Format: chiffres uniquement.
5. to_sell : true uniquement si c'est une VENTE (parcelle, terrain, titre foncier). Sinon false.
6. CLASSIFICATION DE L'INTENTION ("intent") :
   - "CLIENT_DEMAND" : L'auteur du message recherche activement un bien immobilier (ex: "Je cherche une chambre salon...", "Besoin d'un appartement...").
   - "OFFER" : Le message propose/offre un bien immobilier (ex: "Chambre disponible...", "Si vous cherchez une chambre à louer écrivez-moi...").
   - "NOISE" : Le message est du bruit, hors-sujet, ou n'a aucun rapport avec l'immobilier.
7. TARIFICATION JOURNALIÈRE (PRIORITÉ ABSOLUE) : Si l'annonce mentionne une location à la nuitée, par nuit, par jour, "court séjour", "meublé courte durée", "location journalière", ou tout prix exprimé par nuit/jour (ex: "25000/nuit", "15000 la nuit", "35000/j"), alors :
   - Retourne "tarification": "DAILY"
   - Retourne "intent": "NOISE"
   Ces biens sont STRICTEMENT REFUSÉS sur la plateforme. Ne les traite pas comme des offres valides.

🎯 CHAMPS À EXTRAIRE :
- "intent": "CLIENT_DEMAND|OFFER|NOISE"
- "type": "HOUSE|APARTMENT|STUDIO|VILLA|SHOP|STORE|BUILDING|OFFICE"
- "to_sell": false (location uniquement)
- "rent_price": nombre (prix en FCFA) ou null
- "localisation": quartier et points de repère exacts
- "number_living_rooms": nombre de salons
- "number_rooms": nombre de chambres
- "tarification": "MONTHLY|DAILY"
- "sanitary": "YES" ou "NO"
- "manager_phone": numéro extrait du texte ou null
- "description": la description originale

Texte à analyser : "${normalized}"
`;

  try {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'Tu es un expert en analyse immobilière. Réponds uniquement en JSON valide sans bloc markdown.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'LocaPay Scraper'
      },
      timeout: 45000,
    });

    const content = response.data.choices[0].message.content.trim();
    return JSON.parse(content);
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 429 || status === 402) {
      console.error(`❌ [Facebook] Erreur OpenRouter AI FATALE (${status}):`, err.message);
      
      const now = Date.now();
      if (now - lastAiAlertTime > 3600000) { // 1h
        try {
          transporter.sendMail({
            from: `"WhatsApp Bot Alert" <${process.env.MAIL_USERNAME}>`,
            to: 'adjilan2403@gmail.com, agossadourin@gmail.com',
            subject: `⚠️ ALERTE BOT : OpenRouter AI hors service (Facebook)`,
            text: `Une erreur est survenue sur le traitement Facebook.\n\nErreur HTTP ${status} - L'API OpenRouter est bloquée (Quota ou Paiement). Le traitement a été suspendu.\n\nDate : ${new Date().toLocaleString()}`,
          }).catch(e => console.error("Échec mail:", e.message));
          console.log(`✅ [Facebook] Alerte mail envoyée avec succès.`);
          lastAiAlertTime = now;
        } catch (e) {}
      }
      throw new Error('OPENROUTER_QUOTA_EXCEEDED');
    }
    console.error('❌ [Facebook] Erreur OpenRouter AI:', err.message);
    return null;
  }
}

/**
 * Traite un post Facebook unique :
 * 1. Filtre (mots interdits, pas de média)
 * 2. Télécharge les images
 * 3. Extrait le téléphone (regex → IA)
 * 4. Appelle NestJS /create-from-facebook
 * 5. Met à jour la DB
 *
 * @param {object} post       - Ligne de la table facebook_posts
 * @param {object} db         - Pool PostgreSQL
 * @param {object} groupInfo  - { group_url, group_name }
 * @returns {{ success: boolean, propertyId?: number, error?: string }}
 */
async function processFacebookPost(post, db, groupInfo) {
  const postId = post.post_id;

  try {
    // ── 0. Filtre plus de 24h (première contrainte d'ancienneté) ────────────
    const postTime = post.estimated_post_at ? new Date(post.estimated_post_at) : null;
    const now = new Date();
    if (postTime && (now.getTime() - postTime.getTime() > 24 * 60 * 60 * 1000)) {
      await db.query(
        `UPDATE facebook_posts SET is_noise = TRUE, analysis_error = 'Bien de plus de 24h', updated_at = NOW() WHERE post_id = $1`,
        [postId]
      );
      console.log(`🚫 [Facebook] Post ${postId} → noise (plus de 24h d'ancienneté: ${postTime.toISOString()})`);
      return { success: false, error: 'Bien de plus de 24h' };
    }

    // ── 1. Filtre mots interdits ────────────────────────────────────────────
    const forbiddenKw = containsForbiddenKeyword(post.text);
    if (forbiddenKw) {
      await db.query(
        `UPDATE facebook_posts SET is_noise = TRUE, analysis_error = $1, updated_at = NOW() WHERE post_id = $2`,
        [`Mot interdit: "${forbiddenKw}"`, postId]
      );
      console.log(`🚫 [Facebook] Post ${postId} → noise (mot interdit: "${forbiddenKw}")`);
      return { success: false, error: `Mot interdit: "${forbiddenKw}"` };
    }

    // ── 2. Filtre absence de média ──────────────────────────────────────────
    const imageUrls = Array.isArray(post.image_urls) ? post.image_urls : JSON.parse(post.image_urls || '[]');
    const hasVideo = post.video_url && post.video_url.trim() !== '';
    const hasSearchKeywords = CLIENT_SEARCH_KEYWORDS.some(kw => normalizeText(post.text).includes(kw));

    if (!hasSearchKeywords && imageUrls.length === 0 && !hasVideo) {
      await db.query(
        `UPDATE facebook_posts SET is_noise = TRUE, analysis_error = 'Aucun média attaché', updated_at = NOW() WHERE post_id = $1`,
        [postId]
      );
      console.log(`🚫 [Facebook] Post ${postId} → noise (aucun média)`);
      return { success: false, error: 'Aucun média attaché' };
    }

    // ── 3. Extraction du téléphone (regex d'abord) ─────────────────────────
    let managerPhone = extractPhone(post.text);
    console.log(`📞 [Facebook] Post ${postId} — téléphone regex: ${managerPhone || 'non trouvé'}`);

    // ── 4. Téléchargement des images ───────────────────────────────────────
    const imagesBase64 = [];
    if (imageUrls.length > 0) {
      console.log(`📸 [Facebook] Téléchargement de ${imageUrls.length} image(s) pour post ${postId}...`);
      for (const url of imageUrls) { // Toutes les images par post
        const img = await downloadImageAsBase64(url);
        if (img) imagesBase64.push(img);
      }

      if (imagesBase64.length === 0) {
        await db.query(
          `UPDATE facebook_posts SET is_noise = TRUE, analysis_error = 'Images expirées ou inaccessibles', updated_at = NOW() WHERE post_id = $1`,
          [postId]
        );
        console.warn(`⚠️ [Facebook] Post ${postId} → noise (aucune image téléchargeable)`);
        return { success: false, error: 'Images expirées ou inaccessibles' };
      }

      console.log(`✅ [Facebook] ${imagesBase64.length}/${imageUrls.length} images téléchargées pour post ${postId}`);
    }

    // ── 5. Analyse IA OpenRouter ──────────────────────────────────────────────
    console.log(`🤖 [Facebook] Analyse OpenRouter pour post ${postId}...`);
    const extractedData = await extractPropertyDataWithAI(post.text);

    if (!extractedData) {
      await db.query(
        `UPDATE facebook_posts SET analysis_error = 'Échec analyse IA', updated_at = NOW() WHERE post_id = $1`,
        [postId]
      );
      return { success: false, error: 'Échec analyse IA' };
    }

    const intent = extractedData.intent || 'OFFER';
    console.log(`🤖 [Facebook] Post ${postId} — intention IA: ${intent}`);

    if (intent === 'NOISE') {
      await db.query(
        `UPDATE facebook_posts SET is_noise = TRUE, analysis_error = 'Classé comme bruit par l''IA', updated_at = NOW() WHERE post_id = $1`,
        [postId]
      );
      return { success: false, error: 'Classé comme bruit par l\'IA' };
    }

    // Si l'IA a détecté une vente
    if (extractedData.to_sell === true) {
      await db.query(
        `UPDATE facebook_posts SET is_noise = TRUE, analysis_error = 'Bien à vendre détecté', updated_at = NOW() WHERE post_id = $1`,
        [postId]
      );
      return { success: false, error: 'Bien à vendre détecté' };
    }

    // Si le regex n'a pas trouvé le téléphone, tenter avec l'IA
    if (!managerPhone && extractedData.manager_phone) {
      const aiPhone = extractPhone(String(extractedData.manager_phone));
      if (aiPhone) {
        managerPhone = aiPhone;
        console.log(`📞 [Facebook] Post ${postId} — téléphone IA: ${managerPhone}`);
      }
    }

    // Pas de téléphone du tout → invalide
    if (!managerPhone) {
      await db.query(
        `UPDATE facebook_posts SET analysis_error = 'Numéro de téléphone introuvable', updated_at = NOW() WHERE post_id = $1`,
        [postId]
      );
      console.warn(`⚠️ [Facebook] Post ${postId} → invalide (pas de téléphone)`);
      return { success: false, error: 'Numéro de téléphone introuvable' };
    }

    // Filtrer les locations journalières (à la nuitée / par jour)
    if (extractedData.tarification === 'DAILY') {
      await db.query(
        `UPDATE facebook_posts
         SET is_noise = TRUE,
             analysis_error = 'Location journalière (DAILY) non acceptée',
             updated_at = NOW()
         WHERE post_id = $1`,
        [postId]
      );
      console.log(`🚫 [Facebook] Post ${postId} → noise (location journalière DAILY détectée)`);
      return { success: false, error: 'Location journalière (DAILY) non acceptée' };
    }

    // Si l'IA confirme que c'est une demande client
    if (intent === 'CLIENT_DEMAND') {
      await db.query(
        `UPDATE facebook_posts 
         SET is_processed = TRUE, 
             is_noise = FALSE, 
             is_client_demand = TRUE, 
             phone_extracted = $1, 
             analysis_error = NULL, 
             updated_at = NOW() 
         WHERE post_id = $2`,
        [managerPhone, postId]
      );
      console.log(`🎯 [Facebook] Post ${postId} → classé comme Demande Client par l'IA`);
      return { success: true };
    }

    // C'est une offre (OFFER) : On vérifie la présence de média obligatoirement
    if (imagesBase64.length === 0 && !hasVideo) {
      await db.query(
        `UPDATE facebook_posts SET is_noise = TRUE, analysis_error = 'Aucun média attaché pour une offre', updated_at = NOW() WHERE post_id = $1`,
        [postId]
      );
      console.log(`🚫 [Facebook] Post ${postId} → noise (offre sans média)`);
      return { success: false, error: 'Aucun média attaché pour une offre' };
    }

    // Sauvegarder le téléphone extrait
    await db.query(
      `UPDATE facebook_posts SET phone_extracted = $1, updated_at = NOW() WHERE post_id = $2`,
      [managerPhone, postId]
    );

    // ── 6. Envoi à NestJS /create-from-facebook ────────────────────────────
    const nestUrl = process.env.NESTJS_FACEBOOK_URL
      || process.env.NESTJS_API_URL?.replace('create-from-whatsapp', 'create-from-facebook')
      || 'http://nestjs_app:8000/properties/create-from-facebook';

    console.log(`📤 [Facebook] Envoi à NestJS: ${imagesBase64.length} images, post ${postId}...`);

    const nestResponse = await axios.post(nestUrl, {
      description: post.text,
      manager_phone: managerPhone,
      images_base64: imagesBase64,
      user_id: process.env.LOCAPAY_BOT_USER_ID || 1,
      extracted_data: extractedData,
      // Traçabilité Facebook
      facebook_group_url: groupInfo.group_url,
      facebook_group_name: groupInfo.group_name,
      facebook_post_at: post.estimated_post_at || post.scraped_at,
      description_original: post.text,
    }, {
      timeout: 90000, // 90s (images + IA NestJS)
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    });

    const nestData = nestResponse.data?.data || nestResponse.data;

    if (nestData.success) {
      const propertyId = nestData.property_id || nestData.propertyId;
      await db.query(
        `UPDATE facebook_posts 
         SET is_processed = TRUE, real_property_id = $1, analysis_error = NULL, updated_at = NOW()
         WHERE post_id = $2`,
        [propertyId, postId]
      );
      console.log(`✅ [Facebook] Post ${postId} → Bien #${propertyId} créé avec succès`);
      return { success: true, propertyId };
    } else {
      let errMsg = nestData.error || nestData.message || 'Erreur NestJS inconnue';
      if (nestData.missingFields && Array.isArray(nestData.missingFields)) {
        const missingFieldsStr = nestData.missingFields.map(f => f.field).join(', ');
        errMsg += ` (${missingFieldsStr})`;
      }

      await db.query(
        `UPDATE facebook_posts SET analysis_error = $1, updated_at = NOW() WHERE post_id = $2`,
        [errMsg, postId]
      );
      return { success: false, error: errMsg };
    }

  } catch (err) {
    if (err.message === 'OPENROUTER_QUOTA_EXCEEDED') {
      console.log(`⚠️ [Facebook] Post ${postId} laissé en attente suite à erreur OpenRouter.`);
      return { success: false, fatal: true, error: 'OPENROUTER_QUOTA_EXCEEDED' };
    }

    const errMsg = err.response
      ? (err.response.data?.error || err.response.data?.message || `HTTP ${err.response.status}`)
      : err.message;

    await db.query(
      `UPDATE facebook_posts SET analysis_error = $1, updated_at = NOW() WHERE post_id = $2`,
      [errMsg, postId]
    );
    console.error(`❌ [Facebook] Erreur traitement post ${postId}:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Traite tous les posts Facebook non traités (batch)
 * Avec pause de 2s entre chaque pour ne pas saturer NestJS/OpenRouter
 *
 * @param {object} db          - Pool PostgreSQL
 * @param {function} onProgress - Callback de progression optionnel
 * @returns {{ success: number, errors: number, noise: number, total: number }}
 */
async function processFacebookBatch(db, onProgress = null) {
  const { rows: posts } = await db.query(`
    SELECT fp.*, fg.group_url, fg.group_name
    FROM facebook_posts fp
    LEFT JOIN facebook_groups fg ON fp.group_id = fg.group_id
    WHERE fp.is_processed = FALSE
      AND fp.is_noise = FALSE
      AND fp.analysis_error IS NULL
    ORDER BY fp.scraped_at ASC
  `);

  if (posts.length === 0) {
    return { success: 0, errors: 0, noise: 0, total: 0 };
  }

  console.log(`🚀 [Facebook] Début du batch : ${posts.length} posts à traiter`);
  let success = 0, errors = 0, noise = 0;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const groupInfo = { group_url: post.group_url, group_name: post.group_name };

    const result = await processFacebookPost(post, db, groupInfo);

    if (result.fatal) {
      console.log('🛑 [Facebook] Arrêt immédiat du batch suite à une erreur fatale OpenRouter.');
      break;
    }

    if (result.success) success++;
    else if (post.is_noise) noise++;
    else errors++;

    if (onProgress) {
      onProgress({ type: 'progress', current: i + 1, total: posts.length, success, errors, noise });
    }

    // Pause pour ne pas saturer les APIs
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`🏁 [Facebook] Batch terminé — Succès: ${success}, Erreurs: ${errors}, Bruit: ${noise}`);
  return { success, errors, noise, total: posts.length };
}

/**
 * Importe un tableau de posts Apify JSON dans la table facebook_posts
 * Retourne le nombre de posts insérés / ignorés (doublons)
 *
 * @param {Array}  posts - Tableau de posts du JSON Apify
 * @param {object} db    - Pool PostgreSQL
 * Le nom du groupe est auto-généré depuis le group_id du postId.
 */
async function importFacebookPosts(posts, db, explicitGroupId = null) {
  if (!Array.isArray(posts) || posts.length === 0) {
    throw new Error('Le fichier JSON ne contient aucun post valide');
  }

  let inserted = 0, duplicates = 0, noMediaNoise = 0;

  for (const post of posts) {
    // Validation minimale
    if (!post.postId) continue;

    const groupId = explicitGroupId || extractGroupId(post);
    const groupUrl = groupId ? `https://www.facebook.com/groups/${groupId}/` : null;
    // Nom auto-généré depuis l'ID — si le groupe existe déjà, on ne modifie pas son nom
    const autoGroupName = groupId ? `Groupe Facebook ${groupId}` : 'Groupe Facebook Inconnu';

    // Créer le groupe si inexistant. Si déjà présent, on ne touche pas au nom existant.
    if (groupId) {
      await db.query(`
        INSERT INTO facebook_groups (group_id, group_url, group_name, last_scraped_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (group_id) DO UPDATE SET last_scraped_at = NOW()
      `, [groupId, groupUrl, autoGroupName]);
    }

    const imageUrls = Array.isArray(post.imageUrls) ? post.imageUrls : [];
    const videoUrl = post.videoUrl || '';
    const estimatedPostAt = parseRelativeTimestamp(post.scrapedAt, post.timestamp);

    // Détection de mots-clés de recherche
    const managerPhone = extractPhone(post.text);
    const hasSearchKeywords = CLIENT_SEARCH_KEYWORDS.some(kw => normalizeText(post.text).includes(kw));

    // Première contrainte : plus de 24h par rapport à NOW
    const now = new Date();
    const isOlderThan24h = estimatedPostAt ? (now.getTime() - estimatedPostAt.getTime() > 24 * 60 * 60 * 1000) : false;

    // Pré-filtre immédiat : pas de média (sauf si c'est une recherche) ou plus de 24h → noise dès l'import
    const forbiddenKw = containsForbiddenKeyword(post.text);
    let isNoiseOnImport = false;
    let noiseError = null;

    if (forbiddenKw) {
      isNoiseOnImport = true;
      noiseError = `Mot interdit: "${forbiddenKw}"`;
    } else if (hasSearchKeywords && !managerPhone) {
      isNoiseOnImport = true;
      noiseError = 'Recherche sans numéro de téléphone';
    } else if (!hasSearchKeywords && imageUrls.length === 0 && !videoUrl) {
      isNoiseOnImport = true;
      noiseError = 'Aucun média attaché';
    } else if (isOlderThan24h) {
      isNoiseOnImport = true;
      noiseError = 'Bien de plus de 24h';
    }

    try {
      const result = await db.query(`
        INSERT INTO facebook_posts (
          post_id, group_id, author, text, image_urls, video_url,
          post_url, scraped_at, estimated_post_at,
          is_noise, analysis_error, is_client_demand, is_processed, phone_extracted
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (post_id) DO UPDATE SET
          scraped_at = EXCLUDED.scraped_at,
          estimated_post_at = EXCLUDED.estimated_post_at,
          updated_at = NOW()
        RETURNING post_id, is_processed, real_property_id, created_at
      `, [
        post.postId,
        groupId,
        post.author || null,
        post.text || null,
        JSON.stringify(imageUrls),
        videoUrl || null,
        post.postUrl || null,
        post.scrapedAt ? new Date(post.scrapedAt) : new Date(),
        estimatedPostAt,
        isNoiseOnImport,
        noiseError,
        false,
        false,
        null,
      ]);

      if (result.rowCount > 0) {
        const row = result.rows[0];
        const isUpdate = (new Date() - new Date(row.created_at)) > 2000;

        if (isUpdate) {
          duplicates++;
          if (row.is_processed && row.real_property_id) {
            triggerNestPropertyBump(row.real_property_id).catch(err => {
              console.error(`⚠️ [Facebook Bump] Échec du bump pour le bien #${row.real_property_id}:`, err.message);
            });
          }
        } else {
          inserted++;
          if (isNoiseOnImport) noMediaNoise++;
        }
      }
    } catch (err) {
      console.error(`⚠️ [Facebook] Erreur insertion post ${post.postId}:`, err.message);
    }
  }

  return { inserted, duplicates, noMediaNoise };
}

/**
 * Notifie NestJS d'un Bump pour un bien existant (Option B)
 */
async function triggerNestPropertyBump(realPropertyId) {
  const nestUrl = process.env.NESTJS_FACEBOOK_URL
    || process.env.NESTJS_API_URL?.replace('create-from-whatsapp', 'create-from-facebook')
    || 'http://nestjs_app:8000/properties/create-from-facebook';

  // Déduire l'URL de Bump à partir de l'URL NestJS Facebook
  const bumpUrl = nestUrl.replace('/create-from-facebook', `/${realPropertyId}/bump`);

  console.log(`📤 [Facebook Bump] Notification NestJS de Bump pour le bien #${realPropertyId} vers ${bumpUrl}`);

  try {
    const response = await axios.patch(bumpUrl, {}, {
      timeout: 10000,
    });
    console.log(`✅ [Facebook Bump] Bien #${realPropertyId} bumpé avec succès sur NestJS:`, response.data?.message || 'OK');
  } catch (err) {
    const errMsg = err.response ? (err.response.data?.message || `HTTP ${err.response.status}`) : err.message;
    throw new Error(errMsg);
  }
}

module.exports = {
  importFacebookPosts,
  processFacebookPost,
  processFacebookBatch,
  extractPhone,
  containsForbiddenKeyword,
  normalizeText,
  triggerNestPropertyBump,
};
