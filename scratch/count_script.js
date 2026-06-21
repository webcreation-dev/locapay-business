const { Pool } = require('pg');

const locapayPool = new Pool({
    host: '127.0.0.1',
    port: 5435,
    user: 'locapay',
    password: 'YgWsW9ScFtWECh3yx8SX8K',
    database: 'locapay',
});

const whatsappPool = new Pool({
    host: '127.0.0.1',
    port: 15432,
    user: 'postgres',
    password: 'LocapaySecureDB2026PasswordX89',
    database: 'whatsapp_logs',
});

async function main() {
    try {
        const pCount = await locapayPool.query('SELECT COUNT(*) FROM property');
        const pActiveCount = await locapayPool.query('SELECT COUNT(*) FROM property WHERE is_active = true');

        console.log(`LOCAPAY DB - Total properties: ${pCount.rows[0].count}`);
        console.log(`LOCAPAY DB - Active properties: ${pActiveCount.rows[0].count}`);

        const wCount = await whatsappPool.query('SELECT COUNT(*) FROM facebook_posts');
        const wLinkedCount = await whatsappPool.query('SELECT COUNT(*) FROM facebook_posts WHERE real_property_id IS NOT NULL');

        console.log(`WHATSAPP DB - Total posts: ${wCount.rows[0].count}`);
        console.log(`WHATSAPP DB - Posts linked to a real property: ${wLinkedCount.rows[0].count}`);
    } catch (e) {
        console.error(e);
    } finally {
        await locapayPool.end();
        await whatsappPool.end();
    }
}

main();
