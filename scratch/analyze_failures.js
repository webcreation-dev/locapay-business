const fs = require('fs');
const failures = JSON.parse(fs.readFileSync('scratch/failures.json', 'utf8'));

// Print first 20 failures
for (let i = 0; i < 20 && i < failures.length; i++) {
    const f = failures[i];
    console.log(`[Expected: ${f.expected} | Parsed: ${f.parsed}]`);
    console.log(f.text.replace(/\n/g, ' '));
    console.log('---');
}
