const { Pool } = require('pg');
const fs = require('fs');

const locapayPool = new Pool({
    host: '213.136.81.100',
    port: 5435,
    user: 'locapay',
    password: 'YgWsW9ScFtWECh3yx8SX8K',
    database: 'locapay',
});

const whatsappPool = new Pool({
    host: '213.136.81.100',
    port: 15432,
    user: 'postgres',
    password: 'LocapaySecureDB2026PasswordX89',
    database: 'whatsapp_logs',
});

async function main() {
    try {
        console.log('Fetching properties from Locapay DB...');
        const locapayRes = await locapayPool.query(`
            SELECT id as property_id, type, to_sell, rent_price,
                   number_living_rooms, number_rooms, tarification, sanitary,
                   manager_phone
            FROM property
            WHERE is_validated = true OR is_verified = true
        `);
        
        const properties = locapayRes.rows;
        console.log(`Found ${properties.length} validated properties`);
        
        if (properties.length === 0) {
            console.log('No properties found. Exiting.');
            process.exit(0);
        }
        
        const propertyIds = properties.map(p => p.property_id);
        
        console.log('Fetching original posts from Whatsapp Logs DB...');
        const whatsappRes = await whatsappPool.query(`
            SELECT post_id, real_property_id, text as raw_text
            FROM facebook_posts
            WHERE real_property_id = ANY($1)
        `, [propertyIds]);
        
        const posts = whatsappRes.rows;
        console.log(`Found ${posts.length} matching original posts`);
        
        const combined = [];
        for (const post of posts) {
            const prop = properties.find(p => p.property_id === post.real_property_id);
            if (prop && post.raw_text) {
                combined.push({
                    property_id: prop.property_id,
                    post_id: post.post_id,
                    raw_text: post.raw_text,
                    expected: {
                        type: prop.type,
                        to_sell: prop.to_sell,
                        rent_price: prop.rent_price,
                        number_living_rooms: prop.number_living_rooms,
                        number_rooms: prop.number_rooms,
                        tarification: prop.tarification,
                        sanitary: prop.sanitary ? 'YES' : 'NO',
                        manager_phone: prop.manager_phone
                    }
                });
            }
        }
        
        fs.writeFileSync('full_test_dataset.json', JSON.stringify(combined, null, 2));
        console.log(`✅ Successfully saved ${combined.length} complete items to full_test_dataset.json`);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await locapayPool.end();
        await whatsappPool.end();
    }
}

main();
