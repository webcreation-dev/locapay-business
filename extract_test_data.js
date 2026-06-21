const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
    user: 'postgres',
    host: '213.136.81.100',
    database: 'whatsapp_logs',
    password: 'LocapaySecureDB2026PasswordX89',
    port: 15432,
});

async function run() {
    console.log("Connexion à la base de données...");
    try {
        const query = `
            SELECT fp.post_id, fp.text as raw_text, p.*
            FROM facebook_posts fp
            JOIN properties p ON fp.ia_property_id = p.id
            WHERE fp.is_processed = true AND fp.analysis_error IS NULL
            ORDER BY fp.created_at DESC
            LIMIT 200;
        `;
        const res = await pool.query(query);
        fs.writeFileSync('test_dataset.json', JSON.stringify(res.rows, null, 2));
        console.log(`✅ Succès : Extrait ${res.rows.length} posts validés et sauvegardés dans test_dataset.json`);
    } catch (err) {
        console.error("❌ Erreur d'extraction:", err);
    } finally {
        pool.end();
    }
}
run();
