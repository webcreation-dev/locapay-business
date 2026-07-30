-- Script de test pour la colonne most_recent_post_at
-- Date: 2026-07-30

-- 1. Vérifier que la colonne existe
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'facebook_groups'
  AND column_name = 'most_recent_post_at';

-- 2. Vérifier les données actuelles
SELECT
    group_id,
    group_name,
    last_scraped_at,
    most_recent_post_at,
    CASE
        WHEN most_recent_post_at IS NULL THEN '⚠️  NULL'
        WHEN most_recent_post_at > last_scraped_at THEN '✅ Plus récent que last_scraped_at'
        WHEN most_recent_post_at = last_scraped_at THEN '⚠️  Égal à last_scraped_at'
        ELSE '❌ Plus ancien que last_scraped_at'
    END as status
FROM facebook_groups
ORDER BY last_scraped_at DESC
LIMIT 10;

-- 3. Test de la fonction GREATEST() (pour vérifier le comportement lors des updates)
SELECT
    GREATEST('2024-01-15 12:00:00'::timestamptz, '2024-01-15 14:00:00'::timestamptz) as result_1,  -- Devrait retourner 14:00:00
    GREATEST('2024-01-15 16:00:00'::timestamptz, '2024-01-15 14:00:00'::timestamptz) as result_2,  -- Devrait retourner 16:00:00
    GREATEST(NULL, '2024-01-15 14:00:00'::timestamptz) as result_3;  -- Devrait retourner 14:00:00

-- 4. Compter les groupes avec/sans most_recent_post_at
SELECT
    COUNT(*) FILTER (WHERE most_recent_post_at IS NOT NULL) as avec_timestamp,
    COUNT(*) FILTER (WHERE most_recent_post_at IS NULL) as sans_timestamp,
    COUNT(*) as total
FROM facebook_groups;
