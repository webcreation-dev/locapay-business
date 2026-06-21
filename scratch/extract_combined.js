const { Pool } = require('pg');
const fs = require('fs');

const whatsappPool = new Pool({
    user: 'postgres',
    host: '213.136.81.100',
    database: 'whatsapp_logs',
    password: 'LocapaySecureDB2026PasswordX89',
    port: 15432,
});

const locapayPool = new Pool({
    user: 'locapay',
    host: '213.136.81.100',
    database: 'locapay',
    password: 'YgWsW9ScFtWECh3yx8SX8K',
    port: 5435,
});

async function run() {
    console.log("Connexion aux bases de données...");
    try {
        const postsRes = await whatsappPool.query(`
            SELECT post_id, text as raw_text, real_property_id
            FROM facebook_posts
            WHERE is_processed = true AND analysis_error IS NULL AND real_property_id IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 500;
        `);
        
        const posts = postsRes.rows;
        if (posts.length === 0) {
            console.log("Aucun post traité trouvé.");
            return;
        }
        console.log(`Récupéré ${posts.length} posts de whatsapp_logs.`);

        const propertyIds = posts.map(p => p.real_property_id);
        const propsRes = await locapayPool.query(`
            SELECT *
            FROM property
            WHERE id = ANY($1::int[])
        `, [propertyIds]);

        const propsMap = {};
        for (const p of propsRes.rows) {
            propsMap[p.id] = p;
        }

        const dataset = [];
        for (const post of posts) {
            const prop = propsMap[post.real_property_id];
            if (prop) {
                dataset.push({
                    post_id: post.post_id,
                    raw_text: post.raw_text,
                    ai_result: prop
                });
            }
        }

        fs.writeFileSync('test_dataset.json', JSON.stringify(dataset, null, 2));
        console.log(`✅ Succès : Extrait ${dataset.length} éléments fusionnés dans test_dataset.json`);

    } catch (err) {
        console.error("❌ Erreur d'extraction:", err);
    } finally {
        whatsappPool.end();
        locapayPool.end();
    }
}
run();
