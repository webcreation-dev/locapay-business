-- Migration: Ajouter colonne most_recent_post_at
-- Date: 2026-07-30
-- Description: Stocke le timestamp du post le plus récent scrapé (au lieu de NOW())

-- Ajouter la colonne
ALTER TABLE facebook_groups
ADD COLUMN IF NOT EXISTS most_recent_post_at TIMESTAMPTZ;

-- Commentaire pour documentation
COMMENT ON COLUMN facebook_groups.most_recent_post_at IS
'Timestamp du post le plus récent scrapé dans ce groupe. Utilisé comme limite pour le mode continuation.';

-- Initialiser avec last_scraped_at pour les groupes existants
UPDATE facebook_groups
SET most_recent_post_at = last_scraped_at
WHERE most_recent_post_at IS NULL AND last_scraped_at IS NOT NULL;
