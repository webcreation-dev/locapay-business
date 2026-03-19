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
    
    RÈGLES :
    1. Un "Bien Immobilier" est défini par un texte descriptif et ses images/vidéos associées qui le suivent ou le précèdent immédiatement.
    2. Identifie les messages qui ne décrivent PAS un bien (discussions, questions, messages système) et classe-les comme "bruit".
    3. Si un bien semble incomplet (ex: seulement des images sans texte), marque-le comme "incomplet".
    
    DONNÉES :
    ${JSON.stringify(messageContext, null, 2)}
    
    RÉPONSE ATTENDUE (JSON UNIQUEMENT) :
    {
      "properties": [
        {
          "title_summary": "Bref titre du bien",
          "description_msg_ids": [ids des messages texte],
          "media_msg_ids": [ids des messages images/vidéos],
          "estimated_price": "prix si trouvé",
          "is_complete": true/false
        }
      ],
      "noise_msg_ids": [ids des messages à ignorer]
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
            
            // 1. Gérer les Propriétés détectées
            if (result.properties && result.properties.length > 0) {
                for (let i = 0; i < result.properties.length; i++) {
                    const prop = result.properties[i];
                    const groupId = `prop_${Date.now()}_${i}`;
                    
                    const allMsgIds = [
                        ...(prop.description_msg_ids || []),
                        ...(prop.media_msg_ids || [])
                    ];
                    
                    if (allMsgIds.length > 0) {
                        await db.query(
                            'UPDATE messages SET is_analyzed = TRUE, property_group_id = $1 WHERE id = ANY($2)',
                            [groupId, allMsgIds]
                        );
                        console.log(`🏠 Bien #${i+1} : ${allMsgIds.length} messages groupés (ID: ${groupId})`);
                    }
                }
            }
            
            // 2. Gérer le bruit (messages à ignorer)
            if (result.noise_msg_ids && result.noise_msg_ids.length > 0) {
                await db.query(
                    'UPDATE messages SET is_analyzed = TRUE, property_group_id = \'noise\' WHERE id = ANY($1)',
                    [result.noise_msg_ids]
                );
                console.log(`🗑️ ${result.noise_msg_ids.length} messages marqués comme bruit.`);
            }

            // 3. Marquer le reste du lot comme analysé pour ne pas boucler indéfiniment
            // Si l'IA a oublié certains messages du lot, on les marque quand même pour avancer
            const processedIdsInBatch = messages.map(m => m.id);
            await db.query(
                'UPDATE messages SET is_analyzed = TRUE WHERE id = ANY($1) AND is_analyzed = FALSE',
                [processedIdsInBatch]
            );
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
