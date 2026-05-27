require('dotenv').config();
const { Pool } = require('pg');
const { importFacebookPosts } = require('../facebook-processor');

async function runTest() {
  const db = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    console.log('🔌 Connexion à la base de données...');
    await db.query('SELECT 1');

    console.log('🛠️ Ajout de la colonne is_client_demand si elle n\'existe pas...');
    await db.query('ALTER TABLE facebook_posts ADD COLUMN IF NOT EXISTS is_client_demand BOOLEAN DEFAULT FALSE;');

    // Créer un post de test : client à la recherche d'un appartement avec téléphone béninois, sans médias
    const testPost = {
      postId: 'test_client_demand_12345',
      scrapedAt: new Date().toISOString(),
      timestamp: '10m', // 10 minutes ago
      text: 'Bonjour, je cherche activement un studio meublé à Cotonou Calavi. Mon budget est de 80 000 FCFA. Veuillez me contacter au 0196239585 ou par WhatsApp.',
      imageUrls: [], // Pas de média
      videoUrl: ''
    };

    console.log('📥 Importation du post de test...');
    const result = await importFacebookPosts([testPost], db);
    console.log('Resultats de l\'import:', result);

    console.log('🔍 Vérification dans la base de données...');
    const { rows } = await db.query(
      'SELECT post_id, text, is_client_demand, is_processed, phone_extracted, is_noise, analysis_error FROM facebook_posts WHERE post_id = $1',
      [testPost.postId]
    );

    console.log('Enregistrement en BD :', rows[0]);

    if (rows[0] && rows[0].is_client_demand === true && rows[0].is_processed === true && rows[0].phone_extracted === '+2290196239585' && rows[0].is_noise === false) {
      console.log('✅ TEST RÉUSSI : Le post de recherche client a été correctement catégorisé et traité sans IA et sans rejet pour manque de média.');
    } else {
      console.error('❌ TEST ÉCHOUÉ : Les attributs enregistrés ne correspondent pas aux attentes.');
    }

    // Nettoyage après test
    console.log('🧹 Nettoyage du post de test...');
    await db.query('DELETE FROM facebook_posts WHERE post_id = $1', [testPost.postId]);

  } catch (err) {
    console.error('❌ Erreur durant le test:', err.message);
  } finally {
    await db.end();
  }
}

runTest();
