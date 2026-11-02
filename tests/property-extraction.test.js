const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPropertyDataDeterministic } = require('../facebook-processor');

test('reconnaît une orthographe phonétique de Avotrou dans une annonce WhatsApp', () => {
  const data = extractPropertyDataDeterministic(
    '2 chambre un salon disponible 70k avotourou maternité 2 douche condition 3+2+30+1 démarche fait de visite 3k',
  );

  assert.equal(data.rent_price, 70000);
  assert.equal(data.number_rooms, 2);
  assert.equal(data.number_living_rooms, 1);
  assert.equal(data.localisation, 'akpakpa avotrou');
});
