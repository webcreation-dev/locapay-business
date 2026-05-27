require('dotenv').config();
const { Pool } = require('pg');
const { importFacebookPosts, processFacebookPost } = require('../facebook-processor');

async function runTest() {
  const db = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    console.log('🔌 Connexion à la base de données...');
    await db.query('SELECT 1');

    // 1. Post de test : VRAIE demande client (sans média)
    const clientDemandPost = {
      postId: 'test_real_client_demand',
      scrapedAt: new Date().toISOString(),
      timestamp: '10m',
      text: 'Bonjour, je cherche activement un studio meublé à Cotonou Calavi. Mon budget est de 80 000 FCFA. Veuillez me contacter au 0196239585 ou par WhatsApp.',
      imageUrls: [],
      videoUrl: ''
    };

    // 2. Post de test : FAUX POSITIF (offre d'un agent déguisée)
    const falsePositivePost = {
      postId: 'test_false_positive_demand',
      scrapedAt: new Date().toISOString(),
      timestamp: '10m',
      text: 'Si tu cherches de chambre salon sanitaire où entré coucher sanitaire à louer écrit moi sûr WhatsApp 0145718336 maintenant',
      imageUrls: [],
      videoUrl: ''
    };

    // Nettoyer d'anciens tests éventuels
    await db.query('DELETE FROM facebook_posts WHERE post_id IN ($1, $2)', [clientDemandPost.postId, falsePositivePost.postId]);

    console.log('\n📥 1. Importation des posts...');
    const importResult = await importFacebookPosts([clientDemandPost, falsePositivePost], db);
    console.log('Résultats de l\'importation :', importResult);

    console.log('\n🔍 État en base de données après import (is_processed doit être false pour les deux) :');
    const { rows: importRows } = await db.query(
      'SELECT post_id, is_processed, is_client_demand, is_noise, phone_extracted FROM facebook_posts WHERE post_id IN ($1, $2)',
      [clientDemandPost.postId, falsePositivePost.postId]
    );
    console.log(importRows);

    // Charger les lignes complètes de la DB pour le traitement
    const { rows: dbPosts } = await db.query(
      'SELECT * FROM facebook_posts WHERE post_id IN ($1, $2)',
      [clientDemandPost.postId, falsePositivePost.postId]
    );

    const dbClientPost = dbPosts.find(p => p.post_id === clientDemandPost.postId);
    const dbFPPost = dbPosts.find(p => p.post_id === falsePositivePost.postId);

    console.log('\n🤖 2. Traitement de la VRAIE demande client avec l\'IA...');
    const clientResult = await processFacebookPost(dbClientPost, db, { group_url: 'http://test', group_name: 'Test Group' });
    console.log('Résultat traitement vraie demande :', clientResult);

    console.log('\n🤖 3. Traitement du FAUX POSITIF (Si tu cherches...) avec l\'IA...');
    const fpResult = await processFacebookPost(dbFPPost, db, { group_url: 'http://test', group_name: 'Test Group' });
    console.log('Résultat traitement faux positif :', fpResult);

    console.log('\n🔍 État final en base de données :');
    const { rows: finalRows } = await db.query(
      'SELECT post_id, is_processed, is_client_demand, is_noise, phone_extracted, analysis_error FROM facebook_posts WHERE post_id IN ($1, $2)',
      [clientDemandPost.postId, falsePositivePost.postId]
    );
    console.log(finalRows);

    // Nettoyage
    console.log('\n🧹 Nettoyage des posts de test...');
    await db.query('DELETE FROM facebook_posts WHERE post_id IN ($1, $2)', [clientDemandPost.postId, falsePositivePost.postId]);

  } catch (err) {
    console.error('❌ Erreur durant le test :', err.message);
  } finally {
    await db.end();
  }
}

runTest();
