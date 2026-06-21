const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: '213.136.81.100',
    database: 'postgres',
    password: 'LocapaySecureDB2026PasswordX89',
    port: 15432,
});

async function run() {
    try {
        const res = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public';
        `);
        console.log("Tables in postgres db:", res.rows.map(r => r.table_name));
    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}
run();
