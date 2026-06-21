const fs = require('fs');
const data = JSON.parse(fs.readFileSync('full_dataset.json', 'utf8'));

function normalizeText(text) {
  if (!text) return '';
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

const locationSet = new Set();
data.forEach(item => {
    if (item.expected.neighborhood) locationSet.add(normalizeText(item.expected.neighborhood));
    if (item.expected.district) locationSet.add(normalizeText(item.expected.district));
    if (item.expected.municipality) locationSet.add(normalizeText(item.expected.municipality));
    if (item.expected.department) locationSet.add(normalizeText(item.expected.department));
});
const locationDict = Array.from(locationSet).filter(l => l.length > 2).sort((a, b) => b.length - a.length);

fs.writeFileSync('locations_dict.json', JSON.stringify(locationDict, null, 2));
console.log('Saved ' + locationDict.length + ' locations.');
