const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const PUBLIC_API_PATHS = new Set(['/health', '/api/game/state', '/api/game/env']);
const PUBLIC_PREFIXES = ['/explorer-api/'];

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/game/env', (_req, res) => res.json({ isStaging: IS_STAGING }));

// ── Game state (public) ──────────────────────────────────────────────────────

app.get('/api/game/state', async (req, res) => {
  try {
    const roundRes = await pool.query(`
      SELECT * FROM rounds ORDER BY round_number DESC LIMIT 1
    `);
    if (!roundRes.rows.length) {
      return res.json({ round: null, bet: null, players: [] });
    }
    const round = roundRes.rows[0];

    const betsRes = await pool.query(`
      SELECT username, room_slug, outcome FROM bets WHERE round_id = $1
    `, [round.id]);

    let userBet = null;
    if (req.user) {
      const ubRes = await pool.query(`
        SELECT room_slug, amount_tkn, outcome FROM bets
        WHERE round_id = $1 AND user_id = $2
      `, [round.id, req.user.id]);
      userBet = ubRes.rows[0] || null;
    }

    res.json({
      round: {
        id: round.id,
        round_number: round.round_number,
        status: round.status,
        winner_room: round.winner_room,
      },
      bet: userBet,
      players: betsRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Place bet (authenticated) ────────────────────────────────────────────────

app.post('/api/game/bet', async (req, res) => {
  const { room_slug, amount_tkn = 1000 } = req.body;
  const VALID_ROOMS = [
    'master-bedroom', 'library', 'dining-room', 'laundry-room', 'kitchen',
    'kids-bedroom', 'playing-room', 'living-room', 'bathroom',
    'powder-room', 'backyard', 'warehouse', 'reading-room',
  ];
  if (!VALID_ROOMS.includes(room_slug)) {
    return res.status(400).json({ error: 'Invalid room' });
  }
  try {
    const roundRes = await pool.query(`
      SELECT * FROM rounds WHERE status = 'active' ORDER BY round_number DESC LIMIT 1
    `);
    if (!roundRes.rows.length) {
      return res.status(400).json({ error: 'No active round' });
    }
    const round = roundRes.rows[0];
    const bet = await pool.query(`
      INSERT INTO bets (user_id, username, round_id, room_slug, amount_tkn)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [req.user.id, req.user.username, round.id, room_slug, amount_tkn]);
    res.json({ ok: true, bet: bet.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Already bet this round' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Advance round (admin only in prod, open in staging) ──────────────────────

app.post('/api/game/advance', async (req, res) => {
  if (!IS_STAGING && req.user.username !== 'admin' && !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const { winner_room } = req.body;
  const ROOM_SLUGS = [
    'master-bedroom', 'library', 'dining-room', 'laundry-room', 'kitchen',
    'kids-bedroom', 'playing-room', 'living-room', 'bathroom',
    'powder-room', 'backyard', 'warehouse', 'reading-room',
  ];
  try {
    const roundRes = await pool.query(`
      SELECT * FROM rounds ORDER BY round_number DESC LIMIT 1
    `);
    if (!roundRes.rows.length) return res.status(400).json({ error: 'No rounds' });
    const round = roundRes.rows[0];

    if (round.status === 'active') {
      await pool.query(`UPDATE rounds SET status='resolving' WHERE id=$1`, [round.id]);
      return res.json({ ok: true, status: 'resolving' });
    }

    if (round.status === 'resolving') {
      const chosen = winner_room || ROOM_SLUGS[Math.floor(Math.random() * ROOM_SLUGS.length)];
      await pool.query(`
        UPDATE rounds SET status='completed', winner_room=$1, completed_at=NOW()
        WHERE id=$2
      `, [chosen, round.id]);
      await pool.query(`
        UPDATE bets SET outcome = CASE WHEN room_slug = $1 THEN 'lost' ELSE 'won' END
        WHERE round_id = $2
      `, [chosen, round.id]);
      await pool.query(`
        INSERT INTO rounds (round_number, status) VALUES ($1, 'active')
      `, [round.round_number + 1]);
      return res.json({ ok: true, status: 'completed', winner_room: chosen });
    }

    if (round.status === 'completed') {
      const nextRes = await pool.query(`
        SELECT id FROM rounds WHERE status='active' ORDER BY round_number DESC LIMIT 1
      `);
      if (!nextRes.rows.length) {
        await pool.query(`
          INSERT INTO rounds (round_number, status) VALUES ($1, 'active')
        `, [round.round_number + 1]);
      }
      return res.json({ ok: true, status: 'next_round_ready' });
    }

    res.status(400).json({ error: 'Unknown round status' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy press endpoints (kept for schema compat) ──────────────────────────

app.post('/api/press', async (req, res) => {
  try {
    await pool.query(`INSERT INTO presses (user_id, username) VALUES ($1, $2)`,
      [req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS presses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      round_number INTEGER NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      winner_room VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      room_slug VARCHAR(100) NOT NULL,
      amount_tkn INTEGER NOT NULL DEFAULT 1000,
      outcome VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, round_id)
    )
  `);

  // ── Staging seed data ─────────────────────────────────────────────────────
  if (IS_STAGING) {
    const existing = await pool.query(`SELECT COUNT(*) FROM rounds`);
    if (existing.rows[0].count === '0') {

      // Round 5: completed, master-bedroom is the haunted room
      const r5 = await pool.query(`
        INSERT INTO rounds (round_number, status, winner_room, completed_at)
        VALUES (5, 'completed', 'master-bedroom', NOW())
        RETURNING id
      `);
      const r5id = r5.rows[0].id;

      // Bets for round 5 — 8 lost on master-bedroom, rest won
      const r5bets = [
        [9001, 'staging-user-01', 'master-bedroom', 'lost'],
        [9002, 'staging-user-02', 'master-bedroom', 'lost'],
        [9003, 'staging-user-03', 'master-bedroom', 'lost'],
        [9004, 'staging-user-04', 'master-bedroom', 'lost'],
        [9005, 'staging-user-05', 'master-bedroom', 'lost'],
        [9006, 'staging-user-06', 'master-bedroom', 'lost'],
        [9007, 'staging-user-07', 'master-bedroom', 'lost'],
        [9008, 'staging-user-08', 'master-bedroom', 'lost'],
        [9009, 'staging-user-09', 'library',        'won'],
        [9010, 'staging-user-10', 'library',        'won'],
        [9011, 'staging-user-11', 'library',        'won'],
        [9012, 'staging-user-12', 'library',        'won'],
        [9013, 'staging-user-13', 'library',        'won'],
        [9014, 'staging-user-14', 'library',        'won'],
        [9015, 'staging-user-15', 'kitchen',        'won'],
        [9016, 'staging-user-16', 'backyard',       'won'],
        [9017, 'staging-user-17', 'living-room',    'won'],
        [9018, 'staging-user-18', 'warehouse',      'won'],
        [9019, 'staging-user-19', 'reading-room',   'won'],
      ];
      for (const [uid, uname, room, outcome] of r5bets) {
        await pool.query(`
          INSERT INTO bets (user_id, username, round_id, room_slug, amount_tkn, outcome)
          VALUES ($1, $2, $3, $4, 1000, $5)
          ON CONFLICT DO NOTHING
        `, [uid, uname, r5id, room, outcome]);
      }

      // Round 6: active, with 5 demo bets pre-placed
      const r6 = await pool.query(`
        INSERT INTO rounds (round_number, status)
        VALUES (6, 'active')
        RETURNING id
      `);
      const r6id = r6.rows[0].id;

      const r6bets = [
        [9101, 'staging-demo-01', 'library'],
        [9102, 'staging-demo-02', 'kitchen'],
        [9103, 'staging-demo-03', 'backyard'],
        [9104, 'staging-demo-04', 'living-room'],
        [9105, 'staging-demo-05', 'reading-room'],
      ];
      for (const [uid, uname, room] of r6bets) {
        await pool.query(`
          INSERT INTO bets (user_id, username, round_id, room_slug, amount_tkn, outcome)
          VALUES ($1, $2, $3, $4, 1000, 'pending')
          ON CONFLICT DO NOTHING
        `, [uid, uname, r6id, room]);
      }
    }
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
