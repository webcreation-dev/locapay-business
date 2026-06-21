const { Pool } = require('pg');
const fs = require('fs');

const whatsappPool = new Pool({
    user: 'postgres',
    host: '213.136.81.100',
    database: 'whatsapp_logs',
    password: 'LocapaySecureDB2026PasswordX89',
    port: 15432,
});

async function run() {
    try {
        const postsRes = await whatsappPool.query(`
            SELECT post_id, text as raw_text
            FROM facebook_posts
            WHERE is_processed = true AND analysis_error IS NULL
            ORDER BY created_at DESC
            LIMIT 100;
        `);
        
        fs.writeFileSync('test_dataset.json', JSON.stringify(postsRes.rows, null, 2));
        console.log(`✅ ${postsRes.rows.length} textes bruts récupérés avec succès.`);
    } catch (err) {
        console.error(err);
    } finally {
        whatsappPool.end();
    }
}
run();
