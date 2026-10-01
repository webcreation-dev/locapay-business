const assert = require('node:assert/strict');
const test = require('node:test');
const { buildScrapeReportQuery } = require('../facebook-scrape-report-query');

function assertContiguousParameters(query) {
    const indexes = [...query.text.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    assert.deepEqual([...new Set(indexes)].sort((a, b) => a - b),
        query.values.map((_, index) => index + 1));
}

test('un rapport complet conserve le checkpoint date + post_id et six paramètres SQL', () => {
    const oldest = new Date('2026-09-28T12:00:00Z');
    const newest = new Date('2026-09-29T00:00:00Z');
    const query = buildScrapeReportQuery({
        status: 'complete', groupId: 'group-1', oldest, newest,
        newestPostId: 'post-15h', limit: 100, postCount: 15
    });
    assertContiguousParameters(query);
    assert.deepEqual(query.values, ['group-1', oldest, newest, 'post-15h', 100, 15]);
    assert.match(query.text, /last_scrape_status = 'complete'/);
    assert.match(query.text, /most_recent_post_id/);
});

test('un rapport incomplet ne laisse aucun paramètre SQL sans type', () => {
    const query = buildScrapeReportQuery({
        status: 'incomplete', groupId: 'group-2', oldest: null, newest: null,
        limit: 100, postCount: 100
    });
    assertContiguousParameters(query);
    assert.deepEqual(query.values, ['group-2', 100, 100]);
    assert.match(query.text, /last_scrape_status = 'incomplete'/);
    assert.match(query.text, /next_scrape_at = NOW\(\)/);
});
