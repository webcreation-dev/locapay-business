const { Client } = require('pg');
const fs = require('fs');

// --- FB PROCESSOR DEPENDENCIES ---
const CLIENT_SEARCH_KEYWORDS = ['recherche', 'cherche', 'besoin'];

function normalizeTextFB(text) {
  if (!text) return '';
  const result = Array.from(text).map(char => {
    const cp = char.codePointAt(0);
    if (cp >= 0x1D400 && cp <= 0x1D7FF) {
      if (cp >= 0x1D400 && cp <= 0x1D419) return String.fromCodePoint(cp - 0x1D400 + 0x41);
      if (cp >= 0x1D41A && cp <= 0x1D433) return String.fromCodePoint(cp - 0x1D41A + 0x61);
      if (cp >= 0x1D434 && cp <= 0x1D44D) return String.fromCodePoint(cp - 0x1D434 + 0x41);
      if (cp >= 0x1D44E && cp <= 0x1D467) return String.fromCodePoint(cp - 0x1D44E + 0x61);
      if (cp >= 0x1D7CE && cp <= 0x1D7D7) return String.fromCodePoint(cp - 0x1D7CE + 0x30);
    }
    return char;
  }).join('');
  return result.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const locationsFB = JSON.parse(fs.readFileSync('/Users/macbookpro/Documents/BACKEND APPS/MY LOCA/Scrapping/WHATSAPP-WEB-JS/locations_dict.json', 'utf8'));

function extractPropertyDataDeterministic(text) {
    const textLower = normalizeTextFB(text).replace(/\s+/g, ' ');

    const result = {
        intent: 'OFFER',
        type: 'APARTMENT',
        to_sell: false,
        rent_price: null,
        number_living_rooms: 0,
        number_rooms: 0,
        tarification: 'MONTHLY',
        sanitary: 'YES',
        localisation: null,
        description: text
    };

    if (CLIENT_SEARCH_KEYWORDS.some(kw => textLower.includes(kw))) {
        result.intent = 'CLIENT_DEMAND';
    }

    const rentPatterns = [
        /(?:loyer|prix).*?(?::|\.|est de|=|-|\s)*(\d{1,2})\s*millions?\s*(\d{1,3})?(?:\s*mille)?/i,
        /(?:loyer|prix|mensualite)[a-z\s]*(?::|\.|est de|=|-|\s)+(?:(?:~.*?~\s*)?|(?:\d{2,7}[f\s~]*\s*)*)(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})\s*(?:f\b|fr|fcfa|cfa|francs|mille|k\b|mil|(?=\s|$|conditions|avance))/i,
        /(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})\s*(?:f\b|fr|fcfa|cfa|francs|mille|k\b|mil)?\s*(?:\/|par\s+)mois/i,
        /(?:à|de)\s+(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})\s*(?:f\b|fr|fcfa|cfa|francs|mille|k\b|mil)/i,
        /(\d{2,3}(?:[.\s]\d{3})*|\d+)\s*(?:mille|milles|k\b|mil)\s*(?:f\b|fr|fcfa|cfa|francs)?/i,
        /(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})\s*(?:f\b|fr|fcfa|cfa|francs)/i,
        /(?:loyer)\s*(?::|\.|est de|=|-|\s)*(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})/i,
        /(?:de)\s+(\d{1,3}(?:[.\s]\d{3})+)\b/i,
        /(\d{2,4}(?:[.\s]\d{3})+)\b/i
    ];
    for (const pat of rentPatterns) {
        const match = textLower.match(pat);
        if (match) {
            let val;
            if (pat.toString().includes('million')) {
                let m = parseInt(match[1]);
                let k = match[2] ? parseInt(match[2].padEnd(3, '0')) : 0;
                val = m * 1000000 + k * 1000;
            } else {
                let valStr = match[1].replace(/[.\s]/g, '');
                val = parseInt(valStr, 10);
                if (val < 1000 && val >= 10 && /(?:mille|milles|k|mil)/i.test(match[0])) val *= 1000;
                if (val < 1000 && val >= 10 && !/(?:mille|milles|k|mil)/i.test(match[0])) val *= 1000; 
            }
            if (val >= 5000 && val <= 5000000) { result.rent_price = val; break; }
        }
    }

    if (/(?:boutique|magasin)/i.test(textLower)) {
        result.type = 'STORE'; result.number_rooms = 1; result.number_living_rooms = 0;
    } else if (/(?:bureau)/i.test(textLower)) {
        result.type = 'OFFICE'; result.number_rooms = 1; result.number_living_rooms = 0;
    } else if (/(?:villa|maison basse)/i.test(textLower)) {
        result.type = 'VILLA';
    } else if (/(?:studio|entree\s*couche)/i.test(textLower)) {
        result.type = 'STUDIO'; result.number_rooms = 1; result.number_living_rooms = 0;
    } else {
        const roomMatch = textLower.match(/(?:(0?\d+|un|une|deux|trois|quatre|cinq|six|sept|huit)\s*)?(?:chambres?|pieces?)\s*(?:sanitaires?\s*)?(?:ordinaires?\s*)?(?:et\s*|\+?\s*|,?\s*)?(?:(0?\d+|un|une|deux|trois|quatre|cinq|six)\s*)?salons?/i);
        if (roomMatch) {
            const wordToNum = { 'un': 1, 'une': 1, 'deux': 2, 'trois': 3, 'quatre': 4, 'cinq': 5, 'six': 6, 'sept': 7, 'huit': 8 };
            result.number_rooms = parseInt(roomMatch[1], 10) || wordToNum[roomMatch[1]?.trim()] || 1;
            result.number_living_rooms = parseInt(roomMatch[2], 10) || wordToNum[roomMatch[2]?.trim()] || 1;
        } else if (/(?:chambre)/i.test(textLower)) {
            result.number_rooms = 1; result.number_living_rooms = 0;
        } else if (/(?:appartement)/i.test(textLower)) {
             result.number_rooms = 1; result.number_living_rooms = 1;
        }
    }

    if (result.number_rooms === 0 && result.number_living_rooms === 0 && /(?:(un|une|deux|trois|quatre|cinq|six|0?\d+)\s*)pieces?/i.test(textLower)) {
        const pMatch = textLower.match(/(?:(un|une|deux|trois|quatre|cinq|six|0?\d+)\s*)pieces?/i);
        const wordToNum = { 'un': 1, 'une': 1, 'deux': 2, 'trois': 3, 'quatre': 4, 'cinq': 5, 'six': 6 };
        let num = parseInt(pMatch[1]) || wordToNum[pMatch[1]] || 1;
        result.number_rooms = num; result.number_living_rooms = 0;
    }

    if (/(?:sanitaire|douche|wc|toilette|wcd)/i.test(textLower)) result.sanitary = 'YES';
    else result.sanitary = 'NO';

    for (const loc of locationsFB) {
        const regex = new RegExp(`\\b${loc.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
        if (regex.test(textLower)) { result.localisation = loc; break; }
    }

    return result;
}

// --- NESTJS BACKEND DEPENDENCIES ---
const geoDataPath = '/Users/macbookpro/Documents/BACKEND APPS/MY LOCA/LOCAPAY-NEST-JS/src/database/seeding/data/donnees_geo_benin.json';
const geoData = JSON.parse(fs.readFileSync(geoDataPath, 'utf8'));

function normalizeTextNest(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
}

const allNeighborhoodsNest = [];
const extractNeighborhoods = (obj) => {
    if (Array.isArray(obj)) {
      obj.forEach((item) => extractNeighborhoods(item));
    } else if (obj && typeof obj === 'object') {
      if (obj.value) allNeighborhoodsNest.push(normalizeTextNest(obj.value));
      if (obj.label) allNeighborhoodsNest.push(normalizeTextNest(obj.label));
      Object.values(obj).forEach((v) => extractNeighborhoods(v));
    }
};
extractNeighborhoods(geoData);

function checkNeighborhoodInGeoData(neighborhood) {
    if (!neighborhood) return false;
    const normalizedInput = normalizeTextNest(neighborhood);
    return allNeighborhoodsNest.some(
      (n) => n === normalizedInput || n.includes(normalizedInput) || normalizedInput.includes(n),
    );
}

function checkNeighborhoodInDescription(neighborhood, description) {
    if (!neighborhood || !description) return false;
    const normalizedDesc = normalizeTextNest(description);
    const normalizedNeighborhood = normalizeTextNest(neighborhood);
    return normalizedDesc.includes(normalizedNeighborhood);
}

function checkPriceInDescription(price, description) {
    if (!price || !description) return false;
    const normalizedDesc = normalizeTextNest(description);
    const priceStr = price.toString();

    if (normalizedDesc.includes(priceStr)) return true;

    const priceWithSpaces = priceStr.replace(/(\d)(?=(\d{3})+$)/g, '$1 ');
    if (normalizedDesc.includes(priceWithSpaces)) return true;

    const priceWithDots = priceStr.replace(/(\d)(?=(\d{3})+$)/g, '$1.');
    if (normalizedDesc.includes(priceWithDots)) return true;

    const thousands = Math.floor(price / 1000);
    if (thousands > 0) {
      const millePatterns = [
        `${thousands} mille`,
        `${thousands} milles`,
        `${thousands}mille`,
        `${thousands} mil`,
        `${thousands}mil`,
        `${thousands} mill`,
        `${thousands}mill`,
        `${thousands}k`,
        `${thousands} k`,
        `${thousands}m`,
        `${thousands} m`,
        `${thousands} ttc`,
        `${thousands}ttc`,
      ];
      if (millePatterns.some((p) => normalizedDesc.includes(p))) return true;
    }
    return false;
}

function evaluatePropertyAutoValidation(property) {
    const reasons = [];

    if (!property.description || !property.rent_price || !property.neighborhood || !property.type) {
      reasons.push('description, rent_price, neighborhood ou type manquant');
    }
    if (property.rent_price && !checkPriceInDescription(property.rent_price, property.description)) {
      reasons.push(`loyer "${property.rent_price}" absent de la description`);
    }
    if (property.neighborhood && !checkNeighborhoodInDescription(property.neighborhood, property.description)) {
      reasons.push(`quartier "${property.neighborhood}" absent de la description`);
    }
    if (property.neighborhood && !checkNeighborhoodInGeoData(property.neighborhood)) {
      reasons.push(`quartier "${property.neighborhood}" non reconnu dans la liste officielle`);
    }

    return {
      isValid: reasons.length === 0,
      reasons,
    };
}


async function runSimulation() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:LocapaySecureDB2026PasswordX89@213.136.81.100:15432/whatsapp_logs',
        ssl: false
    });

    try {
        await client.connect();
        console.log("Connecté à la base de données.");

        const query = `
            SELECT scraped_at, text, post_id
            FROM facebook_posts
            WHERE analysis_error IN (
                'Moins de 3 images attachées', 
                'Moins de 3 images accessibles', 
                'Moins de 3 images attachées pour une offre'
            )
            AND scraped_at >= CURRENT_DATE - INTERVAL '14 days'
            ORDER BY scraped_at DESC
        `;

        const { rows } = await client.query(query);
        console.log(`Trouvé ${rows.length} posts rejetés uniquement à cause du manque d'images.\n`);

        const resultsByDay = {};

        for (const row of rows) {
            const dateStr = new Date(row.scraped_at).toISOString().split('T')[0];
            
            if (!resultsByDay[dateStr]) {
                resultsByDay[dateStr] = {
                    totalRejected: 0,
                    wouldHavePassed: 0
                };
            }
            resultsByDay[dateStr].totalRejected++;

            // 1. Extraction locale (scraper)
            const extractedData = extractPropertyDataDeterministic(row.text);
            
            // Si pas d'intention offre, l'algorithme original rejetterait ou ignorerait.
            if (extractedData.intent !== 'OFFER') continue;

            // 2. Formatage pour validation Backend
            const propertyToValidate = {
                description: row.text,
                rent_price: extractedData.rent_price,
                neighborhood: extractedData.localisation,
                type: extractedData.type
            };

            // 3. Validation backend
            const validation = evaluatePropertyAutoValidation(propertyToValidate);
            if (validation.isValid) {
                resultsByDay[dateStr].wouldHavePassed++;
            }
        }

        console.log("Résultats des biens qui auraient été PUBLIÉS (Auto-Validation réussie) sans la contrainte des 3 images :");
        console.table(resultsByDay);

    } catch (err) {
        console.error("Erreur durant la simulation :", err);
    } finally {
        await client.end();
    }
}

runSimulation();
