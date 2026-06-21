const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: '213.136.81.100',
    database: 'whatsapp_logs',
    password: 'LocapaySecureDB2026PasswordX89',
    port: 15432,
});

async function run() {
    try {
        const res = await pool.query(`SELECT datname FROM pg_database;`);
        console.log("Databases:", res.rows.map(r => r.datname));
    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}
run();
