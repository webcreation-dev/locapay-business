require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const configPath = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const db = new Pool({
    connectionString: process.env.DATABASE_URL
});

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = process.env.AI_MODEL || 'mistral-medium';

/**
 * Récupère les messages non traités pour un chat spécifique
 */
async function getUnprocessedMessages(chatId, limit = 20) {
    const query = `
        SELECT id, message_id, body, timestamp, sender_name, has_media, media_path, message_type
        FROM messages
        WHERE chat_id = $1 AND is_analyzed = FALSE
        ORDER BY timestamp ASC
        LIMIT $2
    `;
    const { rows } = await db.query(query, [chatId, limit]);
    return rows;
}

/**
 * Envoie le lot de messages à Mistral pour segmentation
 */
async function segmentMessagesWithAI(messages) {
    if (messages.length === 0) return null;

    // Préparation du prompt
    const messageContext = messages.map(m => ({
        id: m.id,
        sender: m.sender_name,
        type: m.message_type,
        body: m.body,
        media: m.has_media ? m.media_path : null
    }));

    const prompt = `
    Ta mission est d'analyser une liste de messages WhatsApp provenant d'un groupe immobilier et de les regrouper par "Bien Immobilier".
    
    RÈGLES CRITIQUES :
    1. Un "Bien Immobilier" est un groupe de messages (texte + photos/vidéos) décrivant une LOCATION.
    2. FILTRE DE VENTE : Tout ce qui concerne une VENTE, un ACHAT, une PARCELLE à vendre, ou un TERRAIN doit être classé comme "ignored_sales".
    3. IDENTIFICATION DU BRUIT : Les messages système, les discussions ("merci", "est-ce dispo ?"), ou les messages sans rapport sont du "noise".
    4. GESTION DES ORPHELINS : Si un lot se termine par des messages qui semblent être le DEBUT d'une annonce (ex: un texte sans ses photos qui arrivent probablement après), classe ces IDs dans "incomplete_ids". Ils seront traités au prochain tour.
    
    DONNÉES (Lot de ${messages.length} messages) :
    ${JSON.stringify(messageContext, null, 2)}
    
    RÉPONSE ATTENDUE (JSON UNIQUEMENT) :
    {
      "groups": [
        {
          "type": "rental" ou "ignored_sales",
          "msg_ids": [liste des ids],
          "summary": "bref descriptif"
        }
      ],
      "noise_ids": [ids des messages de discussion/bruit],
      "incomplete_ids": [ids des messages à reporter au prochain tour car tronqués]
    }
    `;

    try {
        const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model: MISTRAL_MODEL,
            messages: [
                { role: 'system', content: 'Tu es un expert en analyse de données immobilières. Réponds uniquement en JSON valide.' },
                { role: 'user', content: prompt }
            ],
            response_format: { type: 'json_object' }
        }, {
            headers: {
                'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return JSON.parse(response.data.choices[0].message.content);
    } catch (error) {
        console.error("❌ Erreur Mistral AI:", error.response ? error.response.data : error.message);
        return null;
    }
}

/**
 * Fonction principale de segmentation
 */
async function runSegmentation() {
    if (config.ai_segmentation_enabled === false) {
        console.log("⏸️ Segmentation IA désactivée dans config.json.");
        return;
    }
    console.log("🚀 Lancement de la segmentation IA...");
    
    for (const chat of config.analyzed_chats) {
        if (!chat.active) continue;
        
        console.log(`\n📂 Analyse du groupe: ${chat.name} (${chat.id})`);
        const messages = await getUnprocessedMessages(chat.id, config.batch_size || 20);
        
        if (messages.length === 0) {
            console.log("✅ Aucun nouveau message à traiter.");
            continue;
        }

        console.log(`💬 ${messages.length} messages récupérés. Envoi à Mistral...`);
        const result = await segmentMessagesWithAI(messages);

        if (result) {
            console.log("✨ Résultat de la segmentation reçu.");
            
            // 1. Gérer les Groupes (Locations ou Ventes à ignorer)
            if (result.groups && result.groups.length > 0) {
                for (let i = 0; i < result.groups.length; i++) {
                    const group = result.groups[i];
                    const isSale = group.type === 'ignored_sales';
                    const groupId = isSale ? `ignore_sale_${Date.now()}_${i}` : `prop_${Date.now()}_${i}`;
                    
                    if (group.msg_ids && group.msg_ids.length > 0) {
                        await db.query(
                            'UPDATE messages SET is_analyzed = TRUE, analyzed_at = CURRENT_TIMESTAMP, property_group_id = $1 WHERE id = ANY($2)',
                            [groupId, group.msg_ids]
                        );
                        console.log(`${isSale ? '🛑 Vente/Parcelle' : '🏠 Bien'} : ${group.msg_ids.length} messages groupés (ID: ${groupId})`);
                    }
                }
            }
            
            // 2. Gérer le bruit
            if (result.noise_ids && result.noise_ids.length > 0) {
                await db.query(
                    'UPDATE messages SET is_analyzed = TRUE, analyzed_at = CURRENT_TIMESTAMP, property_group_id = \'noise\' WHERE id = ANY($1)',
                    [result.noise_ids]
                );
                console.log(`🗑️ ${result.noise_ids.length} messages marqués comme bruit.`);
            }

            // 3. Gérer les Incomplets (On ne les marque PAS comme analysés pour les reprendre plus tard)
            if (result.incomplete_ids && result.incomplete_ids.length > 0) {
                console.log(`⏳ ${result.incomplete_ids.length} messages reportés au prochain tour (orphelins).`);
                // On ne fait rien, is_analyzed reste à FALSE
            }

            // 4. Marquer le reste du lot (sauf les incomplets) comme analysé
            const allIncompleteIds = result.incomplete_ids || [];
            const idsToFinalize = messages
                .filter(m => !allIncompleteIds.includes(m.id))
                .map(m => m.id);

            if (idsToFinalize.length > 0) {
                await db.query(
                    'UPDATE messages SET is_analyzed = TRUE, analyzed_at = CURRENT_TIMESTAMP WHERE id = ANY($1) AND is_analyzed = FALSE AND property_group_id IS NULL',
                    [idsToFinalize]
                );
            }
        }
    }
}

// Exécution si appelé directement
if (require.main === module) {
    runSegmentation().then(() => {
        console.log("\n🏁 Fin du cycle de segmentation.");
        process.exit(0);
    });
}

module.exports = { runSegmentation };
