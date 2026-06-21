const { Pool } = require('pg');
const fs = require('fs');

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
        const locapayRes = await locapayPool.query(`
            SELECT id as property_id, type, to_sell, rent_price,
                   number_living_rooms, number_rooms, tarification, sanitary,
                   manager_phone,
                   neighborhood, district, municipality, department
            FROM property
            WHERE tarification IS DISTINCT FROM 'DAILY'
        `);
        
        const properties = locapayRes.rows;
        const propertyIds = properties.map(p => p.property_id);
        
        if (propertyIds.length === 0) {
            console.log("[]");
            process.exit(0);
        }

        const whatsappRes = await whatsappPool.query(`
            SELECT post_id, real_property_id, text as raw_text
            FROM facebook_posts
            WHERE real_property_id = ANY($1)
        `, [propertyIds]);
        
        const posts = whatsappRes.rows;
        
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
                        sanitary: prop.sanitary,
                        manager_phone: prop.manager_phone,
                        neighborhood: prop.neighborhood,
                        district: prop.district,
                        municipality: prop.municipality,
                        department: prop.department
                    }
                });
            }
        }
        
        fs.writeFileSync('/root/full_dataset.json', JSON.stringify(combined, null, 2));
        console.log("SUCCESS");
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await locapayPool.end();
        await whatsappPool.end();
    }
}

main();
