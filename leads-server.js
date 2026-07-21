require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Connexion PostgreSQL ─────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

// ─── Initialisation de la table lead_actions ─────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_actions (
      post_id   TEXT        NOT NULL,
      author    TEXT,
      action    TEXT        NOT NULL CHECK (action IN ('contacted', 'ignored')),
      acted_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (post_id)
    )
  `);
  // Index sur l'auteur pour ignorer rapidement tous ses posts
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_lead_actions_author ON lead_actions (author)
  `);
  console.log('✅ Table lead_actions prête.');
}

// ─── Extraction du numéro de téléphone béninois ───────────────────
function extractPhone(text) {
  if (!text) return null;

  // Fusion des chiffres séparés par espace ou tiret (ex: "01 98 85 11 74")
  const cleaned = text.replace(/(\d)[\s\-](\d)/g, '$1$2');

  const patterns = [
    // Indicatif +229 ou 00229 + nouveau format 10 chiffres (0XXXXXXXXX)
    /\+229(0[1-9]\d{8})/,
    /00229(0[1-9]\d{8})/,
    // Indicatif +229 ou 00229 + ancien format 8 chiffres (XXXXXXXX)
    /\+229([4-9]\d{7})/,
    /00229([4-9]\d{7})/,
    // Nouveau format local 10 chiffres sans indicatif : 0XXXXXXXXX
    /\b(0[1-9]\d{8})\b/,
    // Ancien format local 8 chiffres sans indicatif : commence par 4-9
    /\b([4-9]\d{7})\b/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      const num = match[1].replace(/\D/g, '');
      // On préfixe avec l'indicatif Bénin si pas encore présent
      if (num.startsWith('229')) return num;
      return '229' + num;
    }
  }
  return null;
}

// ─── Formatage de date français ──────────────────────────────────
const MONTHS_FR = [
  'Janvier','Février','Mars','Avril','Mai','Juin',
  'Juillet','Août','Septembre','Octobre','Novembre','Décembre'
];
function formatDate(d) {
  const dt = new Date(d);
  const day   = dt.getDate();
  const month = MONTHS_FR[dt.getMonth()];
  const year  = dt.getFullYear();
  const hh    = String(dt.getHours()).padStart(2, '0');
  const mm    = String(dt.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} à ${hh}h${mm}`;
}

// ─── API : Liste des leads (72h, paginée) ────────────────────────
app.get('/api/leads', async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  try {
    // On exclut les posts dont l'auteur a été ignoré (action = 'ignored')
    const countResult = await pool.query(`
      SELECT COUNT(*) 
      FROM facebook_posts fp
      WHERE fp.is_client_demand = TRUE
        AND fp.scraped_at >= NOW() - INTERVAL '14 days'
        AND NOT EXISTS (
          SELECT 1 FROM lead_actions la
          WHERE la.author = fp.author AND la.action = 'ignored'
        )
        AND NOT EXISTS (
          SELECT 1 FROM lead_actions la
          WHERE la.post_id = fp.post_id AND la.action = 'ignored'
        )
    `);
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(`
      SELECT 
        fp.post_id,
        fp.author,
        fp.text,
        fp.post_url,
        fp.scraped_at,
        la.action AS existing_action
      FROM facebook_posts fp
      LEFT JOIN lead_actions la ON la.post_id = fp.post_id
      WHERE fp.is_client_demand = TRUE
        AND fp.scraped_at >= NOW() - INTERVAL '14 days'
        AND NOT EXISTS (
          SELECT 1 FROM lead_actions la2
          WHERE la2.author = fp.author AND la2.action = 'ignored'
        )
        AND NOT EXISTS (
          SELECT 1 FROM lead_actions la3
          WHERE la3.post_id = fp.post_id AND la3.action = 'ignored'
        )
      ORDER BY 
        CASE WHEN la.action = 'contacted' THEN 1 ELSE 0 END ASC,
        fp.scraped_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const leads = result.rows.map(row => ({
      ...row,
      phone: extractPhone(row.text),
      scraped_at_formatted: formatDate(row.scraped_at),
    }));

    res.json({
      leads,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      }
    });
  } catch (err) {
    console.error('Erreur DB:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API : Enregistrer une action (contacted / ignored) ──────────
app.post('/api/leads/action', async (req, res) => {
  const { post_id, author, action } = req.body;

  if (!post_id || !['contacted', 'ignored'].includes(action)) {
    return res.status(400).json({ error: 'post_id et action (contacted|ignored) requis' });
  }

  try {
    if (action === 'ignored' && author) {
      // Ignorer TOUS les posts de cet auteur
      // 1. Mettre en NOISE uniquement les posts "demande client" de cet auteur
      await pool.query(
        `UPDATE facebook_posts 
         SET is_noise = TRUE, is_client_demand = FALSE 
         WHERE author = $1 AND is_client_demand = TRUE`, 
         [author]
      );

      // 2. On récupère tous les post_id de cet auteur dans facebook_posts
      const postsOfAuthor = await pool.query(
        `SELECT post_id FROM facebook_posts WHERE author = $1`, [author]
      );

      // 3. On insère une action ignored pour chacun (upsert)
      for (const row of postsOfAuthor.rows) {
        await pool.query(`
          INSERT INTO lead_actions (post_id, author, action)
          VALUES ($1, $2, $3)
          ON CONFLICT (post_id) DO UPDATE SET action = EXCLUDED.action, acted_at = NOW()
        `, [row.post_id, author, 'ignored']);
      }

      return res.json({ success: true, ignored_count: postsOfAuthor.rows.length });
    }

    // Action normale (contacted ou ignored sur un seul post)
    await pool.query(`
      INSERT INTO lead_actions (post_id, author, action)
      VALUES ($1, $2, $3)
      ON CONFLICT (post_id) DO UPDATE SET action = EXCLUDED.action, acted_at = NOW()
    `, [post_id, author || null, action]);

    res.json({ success: true });
  } catch (err) {
    console.error('Erreur action:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Servir la page HTML ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'leads.html'));
});

const PORT = 3737;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ Serveur LocaPay Leads démarré !`);
    console.log(`👉 Ouvrez votre navigateur sur : http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Erreur initialisation DB:', err.message);
  process.exit(1);
});
