const fs = require('fs');

const failures = JSON.parse(fs.readFileSync('scratch/failures.json', 'utf8'));

const locFailures = failures.filter(f => f.failReasons.some(r => r.includes('Localisation')));
const rentFailures = failures.filter(f => f.failReasons.some(r => r.includes('Rent Price')));

console.log(`Total Loc Failures: ${locFailures.length}`);
console.log(`Total Rent Failures: ${rentFailures.length}`);

console.log('\n--- SAMPLE 5 LOC FAILURES ---');
for(let i=0; i<Math.min(5, locFailures.length); i++) {
    console.log(`\nText: ${locFailures[i].text.substring(0, 150)}...`);
    console.log(`Extracted Loc: ${locFailures[i].parsed_loc}`);
    console.log(`DB Locs: ${locFailures[i].db_locs.join(', ')}`);
}

console.log('\n--- SAMPLE 5 RENT FAILURES ---');
for(let i=0; i<Math.min(5, rentFailures.length); i++) {
    console.log(`\nText: ${rentFailures[i].text.substring(0, 150)}...`);
    console.log(`Extracted Rent: ${rentFailures[i].parsed_rent} | DB Rent: ${rentFailures[i].expected_rent}`);
}
