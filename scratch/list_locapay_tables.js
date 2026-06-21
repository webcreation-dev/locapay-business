const { Pool } = require('pg');
const locapayPool = new Pool({
    user: 'locapay',
    host: '213.136.81.100',
    database: 'locapay',
    password: 'YgWsW9ScFtWECh3yx8SX8K',
    port: 5435,
});
async function run() {
    try {
        const res = await locapayPool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`);
        console.log("Tables in locapay db:", res.rows.map(r => r.table_name));
    } catch (err) {
        console.error(err);
    } finally {
        locapayPool.end();
    }
}
run();
