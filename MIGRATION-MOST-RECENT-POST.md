# Migration: Ajout de most_recent_post_at

## Date: 2026-07-30

## Problème résolu

**Avant:** Le backend utilisait `last_scraped_at = NOW()` (moment de l'import) comme limite pour le mode continuation.

**Problème:** Si le scraping prend 5 minutes, on perd les posts publiés pendant ces 5 minutes.

**Après:** Le backend utilise `most_recent_post_at` (timestamp du post le plus récent scrapé) comme limite.

**Résultat:** Aucune perte de posts, même si le scraping prend du temps.

---

## Changements

### 1. Nouvelle colonne `most_recent_post_at`

```sql
ALTER TABLE facebook_groups
ADD COLUMN most_recent_post_at TIMESTAMPTZ;
```

### 2. Logique de calcul

**facebook-processor.js:**
```javascript
// Calculer le timestamp du post le plus récent
const mostRecentPostTimestamp = posts
  .map(p => parseRelativeTimestamp(p.scrapedAt, p.timestamp))
  .sort((a, b) => b - a)[0];  // Tri DESC, prendre le plus récent

// Sauvegarder avec GREATEST() pour garder le plus récent
INSERT INTO facebook_groups (..., most_recent_post_at)
VALUES (..., $mostRecentPostTimestamp)
ON CONFLICT (group_id) DO UPDATE SET
  most_recent_post_at = GREATEST(
    facebook_groups.most_recent_post_at,
    EXCLUDED.most_recent_post_at
  );
```

### 3. API modifiée

**Endpoint GET /api/facebook/groups/:groupId/scrape-info:**
```javascript
// Retourne most_recent_post_at en priorité, fallback sur last_scraped_at
lastScrapedAt: group.most_recent_post_at || group.last_scraped_at
```

---

## Instructions d'application

### Étape 1: Appliquer la migration SQL

```bash
cd /Users/macbookpro/Documents/BACKEND\ APPS/MY\ LOCA/Scrapping/WHATSAPP-WEB-JS

# Se connecter à PostgreSQL
psql -U postgres -d whatsapp_web_js

# Appliquer la migration
\i migrations/add_most_recent_post_at.sql

# Vérifier que la colonne existe
\d facebook_groups
```

### Étape 2: Redémarrer le backend

```bash
# Arrêter le serveur Node.js
pkill -f "node index.js"

# Redémarrer
node index.js
```

### Étape 3: Tester avec le script SQL

```bash
psql -U postgres -d whatsapp_web_js -f test-most-recent-post.sql
```

**Résultat attendu:**
```
✅ La colonne most_recent_post_at existe
✅ Les groupes existants ont most_recent_post_at = last_scraped_at (initialisation)
✅ GREATEST() fonctionne correctement
```

---

## Scénarios de test

### Test 1: Premier import d'un groupe

**Données:**
- Post 1: "Just now" (12h00)
- Post 2: "2h" (10h00)
- Post 3: "5h" (07h00)

**Attendu:**
- `most_recent_post_at` = 2026-07-30 12:00:00 (post le plus récent)
- `last_scraped_at` = 2026-07-30 12:02:00 (moment de l'import)

### Test 2: Import de continuation

**État initial:**
- `most_recent_post_at` = 2026-07-30 12:00:00

**Nouveaux posts:**
- Post 1: "1h" (13h00)
- Post 2: "30m" (13h30)

**Attendu:**
- `most_recent_post_at` = 2026-07-30 13:30:00 (GREATEST garde le plus récent)
- `last_scraped_at` = 2026-07-30 14:00:00 (moment du nouvel import)

### Test 3: Import avec des posts plus anciens (ne devrait pas arriver en mode continuation)

**État initial:**
- `most_recent_post_at` = 2026-07-30 12:00:00

**Nouveaux posts (erreur, scraping sans mode continuation):**
- Post 1: "8h" (06h00)
- Post 2: "10h" (04h00)

**Attendu:**
- `most_recent_post_at` = 2026-07-30 12:00:00 (GREATEST garde l'ancien)
- Aucune régression

---

## Rollback

Si besoin de revenir en arrière :

```sql
-- Supprimer la colonne
ALTER TABLE facebook_groups DROP COLUMN most_recent_post_at;

-- Revenir au code précédent dans:
-- - index.js (ligne 283)
-- - facebook-processor.js (lignes 783-812, ligne 1662)
-- - index.js endpoint (ligne 1662)
```

---

## Vérification post-migration

```bash
# Tester l'endpoint API
curl http://localhost:3000/api/facebook/groups/YOUR_GROUP_ID/scrape-info

# Résultat attendu:
{
  "groupId": "YOUR_GROUP_ID",
  "groupName": "Nom du groupe",
  "lastScrapedAt": "2026-07-30T12:00:00.000Z",  // ← C'est most_recent_post_at !
  "isValidated": true,
  "isNewGroup": false
}
```

---

## Notes importantes

✅ **Rétro-compatible:** Si `most_recent_post_at` est NULL, l'API utilise `last_scraped_at`
✅ **Pas de perte de données:** Les groupes existants sont initialisés avec `last_scraped_at`
✅ **Pas de modification de l'extension:** L'extension continue à utiliser `lastScrapedAt` (transparent)
✅ **GREATEST() protège contre les régressions:** On garde toujours le timestamp le plus récent
