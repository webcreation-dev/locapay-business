const fs = require('fs');

const data = JSON.parse(fs.readFileSync('full_dataset.json', 'utf8'));

// Build location dictionary from our dataset (in production, this would be fetched once from DB on startup)
const locationSet = new Set();
data.forEach(item => {
    if (item.expected.neighborhood) locationSet.add(normalizeText(item.expected.neighborhood));
    if (item.expected.district) locationSet.add(normalizeText(item.expected.district));
    if (item.expected.municipality) locationSet.add(normalizeText(item.expected.municipality));
    if (item.expected.department) locationSet.add(normalizeText(item.expected.department));
});
// Remove empty strings and sort by length descending to match longest phrases first
const locationDict = Array.from(locationSet).filter(l => l.length > 2).sort((a, b) => b.length - a.length);

function normalizeText(text) {
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
  return result.normalize('NFKD')
               .replace(/[\u0300-\u036f]/g, '')
               .replace(/[*~_#]/g, ' ')
               .toLowerCase();
}

function extractPropertyDataDeterministic(text) {
    const textLower = normalizeText(text).replace(/\s+/g, ' ');

    const result = {
        type: 'APARTMENT',
        rent_price: null,
        number_living_rooms: 0,
        number_rooms: 0,
        sanitary: 'YES',
        localisation: null,
        is_noise: false
    };

    if (textLower.includes('$') || textLower.includes('dollar')) {
        result.is_noise = true;
        return result;
    }

    // LOYER
    const rentPatterns = [
        /(?:loyer|prix).*?(?::|\.|est de|=|-|\s)*(\d{1,2})\s*millions?\s*(\d{1,3})?(?:\s*mille)?/i,
        /(?:loyer|prix|mensualite)[a-z\s]*(?::|\.|est de|=|-|\s)+(?:(?:~.*?~\s*)?|(?:\d{2,7}[f\s~]*\s*)*)(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})\s*(?:f\b|fr|fcfa|cfa|francs|mille|k\b|mil|(?=\s|$|conditions|avance))/i,
        /(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})\s*(?:f\b|fr|fcfa|cfa|francs|mille|k\b|mil)?\s*(?:\/|par\s+)mois/i,
        /(?:à|de)\s+(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})\s*(?:f\b|fr|fcfa|cfa|francs|mille|k\b|mil)/i,
        /(\d{2,3}(?:[.\s]\d{3})*|\d+)\s*(?:mille|milles|k\b|mil)\s*(?:f\b|fr|fcfa|cfa|francs)?/i,
        /(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})\s*(?:f\b|fr|fcfa|cfa|francs)/i,
        /(?:loyer)\s*(?::|\.|est de|=|-|\s)*(\d{1,3}(?:[.\s]\d{3})+|\d{4,7})/i,
        /(?:de)\s+(\d{1,3}(?:[.\s]\d{3})+)\b/i, // "de 25.000"
        /(\d{2,4}(?:[.\s]\d{3})+)\b/i // generic fallback for nicely formatted numbers like 25.000
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
            if (val >= 5000 && val <= 5000000) {
                result.rent_price = val;
                break;
            }
        }
    }

    // TYPE
    if (/(?:boutique|magasin)/i.test(textLower)) {
        result.type = 'STORE';
        result.number_rooms = 1;
        result.number_living_rooms = 0;
    } else if (/(?:bureau)/i.test(textLower)) {
        result.type = 'OFFICE';
        result.number_rooms = 1;
        result.number_living_rooms = 0;
    } else if (/(?:villa|maison basse)/i.test(textLower)) {
        result.type = 'VILLA';
    } else if (/(?:studio|entree\s*couche)/i.test(textLower)) {
        result.type = 'STUDIO';
        result.number_rooms = 1;
        result.number_living_rooms = 0;
    } else {
        result.type = 'APARTMENT';
        const roomMatch = textLower.match(/(?:(0?\d+|un|une|deux|trois|quatre|cinq|six|sept|huit)\s*)?(?:chambres?|pieces?)\s*(?:sanitaires?\s*)?(?:ordinaires?\s*)?(?:et\s*|\+?\s*|,?\s*)?(?:(0?\d+|un|une|deux|trois|quatre|cinq|six)\s*)?salons?/i);
        if (roomMatch) {
            const wordToNum = { 'un': 1, 'une': 1, 'deux': 2, 'trois': 3, 'quatre': 4, 'cinq': 5, 'six': 6, 'sept': 7, 'huit': 8 };
            let roomsStr = roomMatch[1] ? roomMatch[1].trim() : '1';
            let salonsStr = roomMatch[2] ? roomMatch[2].trim() : '1';
            result.number_rooms = parseInt(roomsStr, 10) || wordToNum[roomsStr] || 1;
            result.number_living_rooms = parseInt(salonsStr, 10) || wordToNum[salonsStr] || 1;
        } else if (/(?:chambre)/i.test(textLower)) {
            result.number_rooms = 1;
            result.number_living_rooms = 0;
        } else if (/(?:appartement)/i.test(textLower)) {
             result.number_rooms = 1;
             result.number_living_rooms = 1;
        }
    }

    // fallback pieces if not matched
    if (result.number_rooms === 0 && result.number_living_rooms === 0 && /(?:(un|une|deux|trois|quatre|cinq|six|0?\d+)\s*)pieces?/i.test(textLower)) {
        const pMatch = textLower.match(/(?:(un|une|deux|trois|quatre|cinq|six|0?\d+)\s*)pieces?/i);
        const wordToNum = { 'un': 1, 'une': 1, 'deux': 2, 'trois': 3, 'quatre': 4, 'cinq': 5, 'six': 6 };
        let num = parseInt(pMatch[1]) || wordToNum[pMatch[1]] || 1;
        result.number_rooms = num;
        result.number_living_rooms = 0;
    }

    if (/(?:sanitaire|douche|wc|toilette|wcd)/i.test(textLower)) result.sanitary = 'YES';
    else result.sanitary = 'NO';

    // LOCALISATION
    for (const loc of locationDict) {
        // Find whole words match
        const regex = new RegExp(`\\b${loc.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
        if (regex.test(textLower)) {
            result.localisation = loc;
            break;
        }
    }

    return result;
}

let rentCount = 0;
let locCount = 0;
let validDataCount = 0;
let details = [];

data.forEach((item) => {
    const textLower = normalizeText(item.raw_text).toLowerCase();
    
    // Ignore posts that contain dollars (now noise)
    if (textLower.includes('$') || textLower.includes('dollar')) {
        return; 
    }
    
    validDataCount++;
    const parsed = extractPropertyDataDeterministic(item.raw_text);
    const expected = item.expected;
    
    let failReasons = [];
    
    if (Number(parsed.rent_price) !== Number(expected.rent_price)) {
        failReasons.push(`Rent Price: Expected ${expected.rent_price}, got ${parsed.rent_price}`);
    } else {
        rentCount++;
    }
    
    // Check localisation accuracy
    const dbLocs = [
        expected.neighborhood,
        expected.district,
        expected.municipality,
        expected.department
    ].filter(Boolean).map(l => normalizeText(l));
    
    let locSuccess = false;
    
    if (dbLocs.length === 0) {
        locSuccess = true;
    } else if (parsed.localisation) {
        for (const l of dbLocs) {
            if (parsed.localisation.includes(l) || l.includes(parsed.localisation)) {
                locSuccess = true;
                break;
            }
        }
    }
    
    if (!locSuccess && dbLocs.length > 0) {
        failReasons.push(`Localisation: Expected one of [${dbLocs.join(', ')}], got ${parsed.localisation}`);
    } else {
        locCount++;
    }
    
    if (failReasons.length > 0) {
        details.push({
            id: item.property_id,
            text: item.raw_text.substring(0, 200).replace(/\n/g, ' '),
            expected_rent: expected.rent_price,
            parsed_rent: parsed.rent_price,
            db_locs: dbLocs,
            parsed_loc: parsed.localisation,
            failReasons
        });
    }
});

console.log(`\n✅ Valid Posts Analyzed (No Dollars): ${validDataCount}`);
console.log(`✅ Rent Price Accuracy: ${rentCount} / ${validDataCount} (${Math.round((rentCount/validDataCount)*100)}%)`);
console.log(`✅ Localisation Accuracy: ${locCount} / ${validDataCount} (${Math.round((locCount/validDataCount)*100)}%)`);
console.log(`❌ Properties with at least one failure: ${details.length}`);

fs.writeFileSync('scratch/failures.json', JSON.stringify(details, null, 2));
