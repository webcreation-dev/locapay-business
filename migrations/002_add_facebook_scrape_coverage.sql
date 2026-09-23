-- Suivi de couverture des groupes Facebook. Migration additive : aucun post existant n'est modifié.

ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS cooldown_hours INTEGER NOT NULL DEFAULT 6;
ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_scrape_attempt_at TIMESTAMPTZ;
ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_complete_oldest_post_at TIMESTAMPTZ;
ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_scrape_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_scrape_limit INTEGER;
ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS last_scrape_count INTEGER;
ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS consecutive_limit_hits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE facebook_groups ADD COLUMN IF NOT EXISTS next_scrape_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_fb_groups_next_scrape ON facebook_groups(next_scrape_at);
