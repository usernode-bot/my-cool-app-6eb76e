const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const USERNODE_JWT_PUBLIC_KEY = process.env.USERNODE_JWT_PUBLIC_KEY;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The 11 hiding locations, in Pocong Route (door) order. The first door along
// the walk is worth the least, the last the most. Must match ROOMS in
// public/index.html (same slugs, same order).
const HUNT_ROOMS = [
  'master-bedroom', 'kids-bedroom', 'living-room', 'library', 'kitchen',
  'reading-room', 'bathroom', 'assistants-room', 'secondary-bathroom',
  'storage-room', 'backyard',
];
const roomPoints = (slug) => 100 + 10 * HUNT_ROOMS.indexOf(slug);

const PUBLIC_API_PATHS = new Set(['/health', '/api/game/scores']);
const PUBLIC_PREFIXES = ['/explorer-api/'];

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && USERNODE_JWT_PUBLIC_KEY) {
    try {
      const payload = jwt.verify(token, USERNODE_JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: 'usernode:app:' + process.env.USERNODE_APP_ID,
      });
      if (payload.pur === 'iframe') req.user = payload;
    } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Favicon: answer the browser's automatic /favicon.ico request with a
// successful 204 so it never falls through to the auth-gated catch-all
// (which would return 401 and log a console error). This route is a GET
// on a non-/api/ path, so it bypasses the JWT gate above.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Resolve a hide-and-seek round (authenticated) ────────────────────────────
// Called once by the client when its 60s hiding timer reaches 00:00. The
// server — not the client — picks the room the Pocong enters.

app.post('/api/game/hunt', async (req, res) => {
  const { room = null, dare_room = null } = req.body || {};
  if (room !== null && !HUNT_ROOMS.includes(room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }
  if (dare_room !== null) {
    if (room === null || !HUNT_ROOMS.includes(dare_room) || dare_room === room) {
      return res.status(400).json({ error: 'Invalid dare room' });
    }
  }

  try {
    const lastRes = await pool.query(`
      SELECT streak, created_at FROM game_scores
      WHERE user_id = $1 ORDER BY id DESC LIMIT 1
    `, [req.user.id]);
    if (lastRes.rows.length) {
      const ageMs = Date.now() - new Date(lastRes.rows[0].created_at).getTime();
      if (ageMs < 55000) {
        return res.status(429).json({ error: 'Previous round is still running' });
      }
    }
    const prevStreak = lastRes.rows.length ? lastRes.rows[0].streak : 0;

    let target = null;
    let outcome = 'disqualified';
    let points = 0;
    let streak = 0;
    let multiplier = 1;

    if (room !== null) {
      // Every room has the same 1 in 11 chance of being chosen.
      target = HUNT_ROOMS[crypto.randomInt(HUNT_ROOMS.length)];
      const isFound = target === room || target === dare_room;
      if (isFound) {
        outcome = 'found';
        streak = 0;
        points = 0;
      } else {
        outcome = 'survived';
        streak = prevStreak + 1;
        multiplier = Math.min(1 + 0.25 * (streak - 1), 3);
        points = Math.round(roomPoints(room) * multiplier * (dare_room !== null ? 1.5 : 1));
      }
    }

    await pool.query(`
      INSERT INTO game_scores (user_id, username, room_slug, dare_room, target_room, outcome, points, streak)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [req.user.id, req.user.username, room, dare_room, target, outcome, points, streak]);

    const bestRes = await pool.query(`
      SELECT COALESCE(MAX(points), 0) AS best FROM game_scores
      WHERE user_id = $1 AND outcome = 'survived'
    `, [req.user.id]);

    res.json({
      target,
      outcome,
      points,
      streak,
      multiplier,
      best: bestRes.rows[0].best,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leaderboard (public) ─────────────────────────────────────────────────────

app.get('/api/game/scores', async (req, res) => {
  try {
    const leadersRes = await pool.query(`
      SELECT username, MAX(points) AS best FROM game_scores
      WHERE outcome = 'survived'
      GROUP BY user_id, username
      ORDER BY best DESC
      LIMIT 10
    `);
    let me = null;
    if (req.user) {
      const bestRes = await pool.query(`
        SELECT COALESCE(MAX(points), 0) AS best FROM game_scores
        WHERE user_id = $1 AND outcome = 'survived'
      `, [req.user.id]);
      const streakRes = await pool.query(`
        SELECT streak FROM game_scores WHERE user_id = $1 ORDER BY id DESC LIMIT 1
      `, [req.user.id]);
      me = {
        username: req.user.username,
        best: bestRes.rows[0].best,
        streak: streakRes.rows.length ? streakRes.rows[0].streak : 0,
      };
    }
    res.json({ leaders: leadersRes.rows, me });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy press endpoints (kept, unused by the game) ────────────────────────

app.post('/api/press', async (req, res) => {
  try {
    await pool.query(`INSERT INTO presses (user_id, username) VALUES ($1, $2)`,
      [req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT username, COUNT(*) as presses FROM presses
      GROUP BY username ORDER BY presses DESC LIMIT 50
    `);
    res.json({ leaderboard: rows });
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

  // Append-only score history for the hide-and-seek game. One row per round,
  // per player. Public data: usernames and points only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      room_slug VARCHAR(50),
      dare_room VARCHAR(50),
      target_room VARCHAR(50),
      outcome VARCHAR(20) NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS game_scores_user_idx
    ON game_scores (user_id, created_at DESC)
  `);

  // ── Staging seed data: leaderboard rows only ───────────────────────────────
  if (IS_STAGING) {
    const existing = await pool.query(`
      SELECT COUNT(*) FROM game_scores WHERE username LIKE 'Staging demo%'
    `);
    if (existing.rows[0].count === '0') {
      const seed = [
        ['Staging demo Rina', 900001, 'backyard', 'storage-room', 'survived', 420, 5],
        ['Staging demo Budi', 900002, 'library', null, 'survived', 300, 3],
        ['Staging demo Sari', 900003, 'kitchen', null, 'survived', 250, 2],
        ['Staging demo Joko', 900004, 'bathroom', null, 'survived', 180, 1],
        ['Staging demo Dewi', 900005, 'master-bedroom', null, 'survived', 120, 1],
      ];
      for (const [username, uid, room, dare, outcome, points, streak] of seed) {
        await pool.query(`
          INSERT INTO game_scores (user_id, username, room_slug, dare_room, target_room, outcome, points, streak)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [uid, username, room, dare, 'master-bedroom', outcome, points, streak]);
      }
    }
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
