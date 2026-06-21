const { Pool } = require('pg');
const locapayPool = new Pool({
    host: '213.136.81.100',
    port: 5435,
    user: 'locapay',
    password: 'YgWsW9ScFtWECh3yx8SX8K',
    database: 'locapay',
});
async function main() {
    const res = await locapayPool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'property'");
    console.log(res.rows.map(r => r.column_name));
    await locapayPool.end();
}
main();
