const completeQuery = [
    'UPDATE facebook_groups',
    'SET last_scraped_at = NOW(),',
    '    last_scrape_attempt_at = NOW(),',
    '    last_complete_oldest_post_at = $2,',
    '    most_recent_post_at = CASE',
    '      WHEN $3::timestamptz IS NULL THEN most_recent_post_at',
    '      WHEN most_recent_post_at IS NULL THEN $3::timestamptz',
    '      ELSE GREATEST(most_recent_post_at, $3::timestamptz)',
    '    END,',
    "    last_scrape_status = 'complete',",
    '    last_scrape_limit = $4,',
    '    last_scrape_count = $5,',
    '    consecutive_limit_hits = 0,',
    '    next_scrape_at = NOW() + make_interval(hours => COALESCE(cooldown_hours, 6))',
    'WHERE group_id = $1',
    'RETURNING *'
].join('\n');

const incompleteQuery = [
    'UPDATE facebook_groups',
    'SET last_scrape_attempt_at = NOW(),',
    "    last_scrape_status = 'incomplete',",
    '    last_scrape_limit = $2,',
    '    last_scrape_count = $3,',
    '    consecutive_limit_hits = consecutive_limit_hits + 1,',
    '    next_scrape_at = NOW()',
    'WHERE group_id = $1',
    'RETURNING *'
].join('\n');

function buildScrapeReportQuery({ status, groupId, oldest, newest, limit, postCount }) {
    if (status === 'complete') {
        return { text: completeQuery, values: [groupId, oldest, newest, limit, postCount] };
    }
    if (status === 'incomplete') {
        return { text: incompleteQuery, values: [groupId, limit, postCount] };
    }
    throw new Error('Statut de couverture invalide');
}

module.exports = { buildScrapeReportQuery };
