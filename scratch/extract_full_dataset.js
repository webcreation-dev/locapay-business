const { Client } = require('ssh2');
const { Pool } = require('pg');
const fs = require('fs');
const net = require('net');

const sshConfig = {
    host: '213.136.81.100',
    port: 22,
    username: 'root',
    password: 'DQfhFtvXfr2iXLV28mzQ'
};

const locapayDbConfig = {
    user: 'locapay',
    password: 'YgWsW9ScFtWECh3yx8SX8K',
    database: 'locapay',
};

const whatsappDbConfig = {
    user: 'postgres',
    password: 'LocapaySecureDB2026PasswordX89',
    database: 'whatsapp_logs',
};

const sshClient = new Client();

function createTunnel(remotePort, localPort) {
    return new Promise((resolve, reject) => {
        const server = net.createServer(sock => {
            sshClient.forwardOut(
                sock.remoteAddress,
                sock.remotePort,
                '127.0.0.1',
                remotePort,
                (err, stream) => {
                    if (err) {
                        sock.end();
                        return;
                    }
                    sock.pipe(stream).pipe(sock);
                }
            );
        }).listen(localPort, '127.0.0.1', () => {
            resolve(server);
        });
        server.on('error', reject);
    });
}

sshClient.on('ready', async () => {
    console.log('SSH connection established');
    
    let locapayServer, whatsappServer;
    
    try {
        // Forward VPS port 5435 to local port 5555
        locapayServer = await createTunnel(5435, 5555);
        console.log('Tunnel created for Locapay DB (5435 -> 5555)');
        
        // Forward VPS port 15432 to local port 5556
        whatsappServer = await createTunnel(15432, 5556);
        console.log('Tunnel created for Whatsapp Logs DB (15432 -> 5556)');

        const locapayPool = new Pool({ ...locapayDbConfig, host: '127.0.0.1', port: 5555 });
        const whatsappPool = new Pool({ ...whatsappDbConfig, host: '127.0.0.1', port: 5556 });

        console.log('Fetching properties from Locapay DB...');
        const locapayRes = await locapayPool.query(`
            SELECT id as property_id, type, to_sell, price as rent_price,
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

        await locapayPool.end();
        await whatsappPool.end();
        locapayServer.close();
        whatsappServer.close();
        sshClient.end();
        
    } catch (err) {
        console.error('Error during data extraction:', err);
        if (locapayServer) locapayServer.close();
        if (whatsappServer) whatsappServer.close();
        sshClient.end();
    }
}).connect(sshConfig);
