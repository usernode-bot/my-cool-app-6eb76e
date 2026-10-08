const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const USERNODE_JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '').replace(/\\n/g, '\n');
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const PUBLIC_API_PATHS = new Set([
  '/health',
  '/api/game/state',
  '/api/game/env',
  '/api/game/leaderboard',
]);
const PUBLIC_PREFIXES = ['/explorer-api/'];

// ── Phase timing (ms). Hiding 60s, Pocong walk 6s. ───────────────────────────
const HIDING_MS = 60 * 1000;
const HUNT_MS = 6 * 1000;
// How long a resolved round stays on screen (result banner, jump-scare, lit
// target room) before the next hiding round opens.
const RESULT_MS = 8 * 1000;

// The 11 hiding rooms. Single source of truth on the server side.
const HIDING_ROOMS = [
  { slug: 'kamar-utama',       label: 'Kamar Utama',       step: 3 },
  { slug: 'kamar-anak',        label: 'Kamar Anak-Anak',   step: 2 },
  { slug: 'library',           label: 'Library',           step: 4 },
  { slug: 'kamar-asisten',     label: 'Kamar Asisten',     step: 5 },
  { slug: 'living-room',       label: 'Living Room',       step: 6 },
  { slug: 'gudang',            label: 'Gudang',            step: 7 },
  { slug: 'kitchen-area',      label: 'Kitchen Area',      step: 1 },
  { slug: 'kamar-mandi-kedua', label: 'Kamar Mandi Kedua', step: 1 },
  { slug: 'backyard',          label: 'Backyard',          step: 3 },
  { slug: 'kamar-mandi',       label: 'Kamar Mandi',       step: 2 },
  { slug: 'ruang-baca',        label: 'Ruang Baca',        step: 4 },
];
const ROOM_SLUGS = HIDING_ROOMS.map((r) => r.slug);
const STEP_BY_SLUG = Object.fromEntries(HIDING_ROOMS.map((r) => [r.slug, r.step]));

const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

app.use(express.json());

app.use((req, res, next) => {
  req.now = requestNow(req);
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

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.get('/api/game/env', (_req, res) => res.json({ isStaging: IS_STAGING, hidingMs: HIDING_MS, huntMs: HUNT_MS }));

// ── Round helpers ────────────────────────────────────────────────────────────

function pickTarget() {
  return ROOM_SLUGS[Math.floor(Math.random() * ROOM_SLUGS.length)];
}

// Turns a stored timestamp into a usable Date, or null when it is missing or
// unparseable. A null return means the phase cannot be trusted to have a live
// clock and the round must be moved on.
function toDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Time-gated transitions. Runs before any read of the round so a browser that
// polls is enough to let the clock expire even with no admin. Idempotent, and
// the status is flipped with a conditional UPDATE so two concurrent requests
// cannot both pick a target.
//
// The pass is also self-healing: a row left behind by older code (legacy
// statuses or a missing/unparseable end time) is closed out and superseded by
// a fresh hiding round, so production auto-starts with no manual reset.
async function runTransitions(now) {
  for (let i = 0; i < 4; i++) {
    const r = await pool.query(`SELECT * FROM rounds ORDER BY round_number DESC LIMIT 1`);
    if (!r.rows.length) {
      // A brand-new or emptied table (production included): open round 1 so
      // the game starts on its own. The guard keeps concurrent callers to one.
      const ins = await pool.query(
        `INSERT INTO rounds (round_number, status, hiding_ends_at)
         SELECT 1, 'hiding', $1
         WHERE NOT EXISTS (SELECT 1 FROM rounds)`,
        [new Date(now.getTime() + HIDING_MS)]
      );
      continue;
    }
    const round = r.rows[0];

    if (round.status === 'hiding') {
      const ends = toDate(round.hiding_ends_at);
      if (ends && now <= ends) return;
      const target = pickTarget();
      const upd = await pool.query(
        `UPDATE rounds SET status='hunt', target_room=$1, hunt_ends_at=$2
         WHERE id=$3 AND status='hiding' RETURNING id`,
        [target, new Date(now.getTime() + HUNT_MS), round.id]
      );
      if (!upd.rows.length) continue; // another request won the race
      // Anyone who never locked a room is disqualified to the Spectator
      // Lounge. They have no hides row, so there is nothing to rewrite here:
      // a locked-in hide also carries outcome 'pending' until resolve, and
      // must NOT be caught. Disqualification is reported at read time.
      continue;
    }

    if (round.status === 'hunt') {
      const ends = toDate(round.hunt_ends_at);
      if (ends && now <= ends) return;
      // A legacy hunt row may carry no target; score against a freshly drawn
      // one so nothing stays pending forever.
      const target = round.target_room || pickTarget();
      const upd = await pool.query(
        `UPDATE rounds SET status='resolved', target_room=$1, resolved_at=$2 WHERE id=$3 AND status='hunt' RETURNING id`,
        [target, now, round.id]
      );
      if (!upd.rows.length) continue;
      await resolveRound(round.id, target);
      continue;
    }

    // The resolved round is shown for RESULT_MS, then the next round opens.
    if (round.status === 'resolved') {
      const shown = toDate(round.resolved_at);
      if (shown && now.getTime() < shown.getTime() + RESULT_MS) return;
      const ins = await pool.query(
        `INSERT INTO rounds (round_number, status, hiding_ends_at)
         SELECT $1, 'hiding', $2
         WHERE NOT EXISTS (SELECT 1 FROM rounds WHERE round_number > $3)`,
        [round.round_number + 1, new Date(now.getTime() + HIDING_MS), round.round_number]
      );
      if (!ins.rowCount) continue;
      continue;
    }

    // Legacy or unknown status from the pre-rebuild code ('active',
    // 'resolving', 'completed'): close the round out and let the next loop
    // iteration open the fresh hiding round. The hold is put behind us so the
    // client never sees this round as resolved; nothing is deleted.
    const target = round.target_room || pickTarget();
    const upd = await pool.query(
      `UPDATE rounds SET status='resolved', target_room=$1, resolved_at=$2
       WHERE id=$3 AND status=$4 RETURNING id`,
      [target, new Date(now.getTime() - RESULT_MS), round.id, round.status]
    );
    if (upd.rows.length) await resolveRound(round.id, target);
    continue;
  }
}

async function resolveRound(roundId, targetRoom) {
  const hides = await pool.query(
    `SELECT id, user_id, username, room_slug, daring_room_slug FROM hides WHERE round_id=$1 AND outcome='pending'`,
    [roundId]
  );
  const counts = {};
  for (const h of hides.rows) counts[h.room_slug] = (counts[h.room_slug] || 0) + 1;
  const total = hides.rows.length;

  for (const h of hides.rows) {
    // A daring second pick doubles the exposure: the Pocong entering either
    // room is an elimination. Surviving both earns x1.5 on the round.
    const survived = h.room_slug !== targetRoom && h.daring_room_slug !== targetRoom;
    let points = 0;
    if (survived) {
      const stats = await pool.query(`SELECT current_streak FROM player_stats WHERE user_id=$1`, [h.user_id]);
      const streakBefore = stats.rows[0] ? stats.rows[0].current_streak : 0;
      const base = 100;
      const distance = 25 * (STEP_BY_SLUG[h.room_slug] || 1);
      const scarcity = Math.min(300, Math.round(50 * total / Math.max(1, counts[h.room_slug] || 1)));
      points = Math.round((base + distance + scarcity) * Math.min(3, 1 + 0.1 * streakBefore));
      if (h.daring_room_slug) points = Math.round(points * 1.5);
    }
    const outcome = survived ? 'survived' : 'eliminated';
    await pool.query(`UPDATE hides SET outcome=$1, points_awarded=$2 WHERE id=$3`, [outcome, points, h.id]);
    await applyStats(h.user_id, h.username, survived, points);
  }
}

async function applyStats(userId, username, survived, points) {
  const cur = await pool.query(`SELECT * FROM player_stats WHERE user_id=$1`, [userId]);
  const s = cur.rows[0] || { total_score: 0, best_score: 0, current_streak: 0, best_streak: 0, rounds_survived: 0 };
  const totalScore = Number(s.total_score) + points;
  const bestScore = Math.max(s.best_score, points);
  const streak = survived ? s.current_streak + 1 : 0;
  const bestStreak = Math.max(s.best_streak, streak);
  const survivedRounds = s.rounds_survived + (survived ? 1 : 0);
  await pool.query(
    `INSERT INTO player_stats (user_id, username, total_score, best_score, current_streak, best_streak, rounds_survived, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       username=EXCLUDED.username, total_score=EXCLUDED.total_score,
       best_score=EXCLUDED.best_score, current_streak=EXCLUDED.current_streak,
       best_streak=EXCLUDED.best_streak, rounds_survived=EXCLUDED.rounds_survived,
       updated_at=NOW()`,
    [userId, username, totalScore, bestScore, streak, bestStreak, survivedRounds]
  );
}

// ── Game state (public) ──────────────────────────────────────────────────────

app.get('/api/game/state', async (req, res) => {
  try {
    await runTransitions(req.now);

    const roundRes = await pool.query(`SELECT * FROM rounds ORDER BY round_number DESC LIMIT 1`);
    if (!roundRes.rows.length) {
      return res.json({ round: null, my_hide: null, hides: [], stats: null, server_now: req.now.toISOString() });
    }
    const round = roundRes.rows[0];

    const hidesRes = await pool.query(
      `SELECT username, room_slug, outcome, points_awarded FROM hides WHERE round_id=$1`,
      [round.id]
    );

    let myHide = null;
    let stats = null;
    if (req.user) {
      const mh = await pool.query(
        `SELECT room_slug, daring_room_slug, outcome, points_awarded FROM hides WHERE round_id=$1 AND user_id=$2`,
        [round.id, req.user.id]
      );
      myHide = mh.rows[0] || null;
      if (!myHide && round.status !== 'hiding') {
        // No lock before the countdown ended: the player watched from the
        // Spectator Lounge. Reported here rather than as a stored row.
        myHide = { room_slug: null, daring_room_slug: null, outcome: 'disqualified', points_awarded: 0 };
      }
      const st = await pool.query(`SELECT * FROM player_stats WHERE user_id=$1`, [req.user.id]);
      stats = st.rows[0] || null;
    }

    res.json({
      round: {
        id: round.id,
        round_number: round.round_number,
        status: round.status,
        target_room: round.target_room,
        hiding_ends_at: round.hiding_ends_at,
        hunt_ends_at: round.hunt_ends_at,
      },
      my_hide: myHide,
      hides: hidesRes.rows,
      stats,
      server_now: req.now.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Lock in a hiding room (authenticated) ────────────────────────────────────

app.post('/api/game/hide', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required', action: 'hide in a room' });
  const { room_slug } = req.body || {};
  if (!ROOM_SLUGS.includes(room_slug)) return res.status(400).json({ error: 'Invalid room' });
  try {
    const roundRes = await pool.query(`SELECT * FROM rounds WHERE status='hiding' ORDER BY round_number DESC LIMIT 1`);
    if (!roundRes.rows.length) return res.status(409).json({ error: 'No hiding phase' });
    const round = roundRes.rows[0];
    if (req.now > new Date(round.hiding_ends_at)) {
      return res.status(409).json({ error: 'Hiding phase ended' });
    }
    const hide = await pool.query(
      `INSERT INTO hides (user_id, username, round_id, room_slug, locked_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING room_slug, outcome`,
      [req.user.id, req.user.username, round.id, room_slug, req.now]
    );
    res.json({ ok: true, hide: hide.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already locked' });
    res.status(500).json({ error: err.message });
  }
});

// ── Daring second pick (authenticated) ───────────────────────────────────────
// The restyled "double down": after locking a room, the player may also dare a
// second room. If the Pocong enters either, they are found; surviving both
// multiplies the round's points by 1.5. One daring pick per round, hiding
// phase only, never the locked room itself.

app.post('/api/game/daring', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required', action: 'dare a second room' });
  const { room_slug } = req.body || {};
  if (!ROOM_SLUGS.includes(room_slug)) return res.status(400).json({ error: 'Invalid room' });
  try {
    const roundRes = await pool.query(`SELECT * FROM rounds WHERE status='hiding' ORDER BY round_number DESC LIMIT 1`);
    if (!roundRes.rows.length) return res.status(409).json({ error: 'No hiding phase' });
    const round = roundRes.rows[0];
    if (req.now > new Date(round.hiding_ends_at)) {
      return res.status(409).json({ error: 'Hiding phase ended' });
    }
    const mine = await pool.query(
      `SELECT id, room_slug, daring_room_slug FROM hides WHERE round_id=$1 AND user_id=$2`,
      [round.id, req.user.id]
    );
    if (!mine.rows.length) return res.status(409).json({ error: 'Lock a hiding room first' });
    if (mine.rows[0].daring_room_slug) return res.status(409).json({ error: 'Already dared' });
    if (mine.rows[0].room_slug === room_slug) return res.status(400).json({ error: 'Pick a different room' });
    const upd = await pool.query(
      `UPDATE hides SET daring_room_slug=$1 WHERE id=$2 AND daring_room_slug IS NULL
       RETURNING room_slug, daring_room_slug, outcome`,
      [room_slug, mine.rows[0].id]
    );
    if (!upd.rows.length) return res.status(409).json({ error: 'Already dared' });
    res.json({ ok: true, hide: upd.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Advance round (staging or admin) — forces the next transition ────────────

app.post('/api/game/advance', async (req, res) => {
  if (!IS_STAGING && req.user && req.user.username !== 'admin' && !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    const r = await pool.query(`SELECT * FROM rounds ORDER BY round_number DESC LIMIT 1`);
    if (!r.rows.length) return res.status(400).json({ error: 'No rounds' });
    const round = r.rows[0];

    if (round.status === 'hiding') {
      const target = pickTarget();
      const upd = await pool.query(
        `UPDATE rounds SET status='hunt', target_room=$1, hunt_ends_at=$2
         WHERE id=$3 AND status='hiding' RETURNING id`,
        [target, new Date(req.now.getTime() + HUNT_MS), round.id]
      );
      if (!upd.rows.length) return res.json({ ok: true, status: 'hunt' });
      return res.json({ ok: true, status: 'hunt', target_room: target });
    }

    if (round.status === 'hunt') {
      const upd = await pool.query(
        `UPDATE rounds SET status='resolved', resolved_at=$1 WHERE id=$2 AND status='hunt' RETURNING id`,
        [req.now, round.id]
      );
      if (upd.rows.length) await resolveRound(round.id, round.target_room);
      // The result stays on screen until the clock (RESULT_MS) or the next click.
      return res.json({ ok: true, status: 'resolved' });
    }

    // resolved → ensure a hiding round exists
    const next = await pool.query(`SELECT id FROM rounds WHERE status='hiding' ORDER BY round_number DESC LIMIT 1`);
    if (!next.rows.length) {
      await pool.query(
        `INSERT INTO rounds (round_number, status, hiding_ends_at) VALUES ($1, 'hiding', $2)`,
        [round.round_number + 1, new Date(req.now.getTime() + HIDING_MS)]
      );
    }
    return res.json({ ok: true, status: 'hiding' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leaderboard (public) ─────────────────────────────────────────────────────

app.get('/api/game/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT username, total_score, best_score, current_streak, best_streak, rounds_survived
      FROM player_stats
      ORDER BY best_score DESC, total_score DESC
      LIMIT 20
    `);
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

async function migrate() {
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
      status VARCHAR(20) NOT NULL DEFAULT 'hiding',
      winner_room VARCHAR(100),
      target_room VARCHAR(100),
      hiding_ends_at TIMESTAMPTZ,
      hunt_ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ
    )
  `);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS target_room VARCHAR(100)`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS hiding_ends_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS hunt_ends_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`);

  // Legacy betting table, kept in place so no data is destroyed. No longer read.
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hides (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      room_slug VARCHAR(100) NOT NULL,
      locked_at TIMESTAMPTZ DEFAULT NOW(),
      outcome VARCHAR(20) NOT NULL DEFAULT 'pending',
      points_awarded INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, round_id)
    )
  `);
  await pool.query(`ALTER TABLE hides ADD COLUMN IF NOT EXISTS daring_room_slug VARCHAR(100)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_stats (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      total_score BIGINT NOT NULL DEFAULT 0,
      best_score INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      rounds_survived INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Staging seed data ─────────────────────────────────────────────────────
  if (IS_STAGING) {
    const existing = await pool.query(`SELECT COUNT(*) FROM rounds`);
    if (existing.rows[0].count === '0') {
      const now = new Date();
      const r = await pool.query(
        `INSERT INTO rounds (round_number, status, hiding_ends_at)
         VALUES (6, 'hiding', $1) RETURNING id`,
        [new Date(now.getTime() + HIDING_MS)]
      );
      const roundId = r.rows[0].id;
      const seeded = [
        ['staging-demo-user', 900001, 'library'],
        ['staging-user-01', 900002, 'kamar-utama'],
        ['staging-user-02', 900003, 'kamar-utama'],
        ['staging-user-03', 900004, 'gudang'],
        ['staging-user-04', 900005, 'living-room'],
      ];
      for (const [username, uid, room] of seeded) {
        await pool.query(
          `INSERT INTO hides (user_id, username, round_id, room_slug)
           VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, round_id) DO NOTHING`,
          [uid, username, roundId, room]
        );
      }
      const stats = [
        ['staging-demo-user', 900001, 1240, 1240, 3, 3, 5],
        ['staging-user-01', 900002, 980, 420, 1, 3, 4],
        ['staging-user-02', 900003, 760, 380, 0, 2, 3],
        ['staging-user-03', 900004, 640, 320, 2, 2, 3],
        ['staging-user-04', 900005, 410, 205, 1, 1, 2],
        ['staging-user-05', 900006, 180, 90, 0, 1, 1],
      ];
      for (const [username, uid, total, best, cur, bestStreak, survived] of stats) {
        await pool.query(
          `INSERT INTO player_stats (user_id, username, total_score, best_score, current_streak, best_streak, rounds_survived)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id) DO NOTHING`,
          [uid, username, total, best, cur, bestStreak, survived]
        );
      }
    }
  }
}

let shuttingDown = false;

async function start() {
  await migrate();
  // Heal any stuck or legacy round data before the first request arrives, and
  // open a round when the table is empty, so production auto-starts.
  try { await runTransitions(new Date()); }
  catch (e) { console.error('[start] round heal failed:', e.message); }
  server = app.listen(port, () => console.log(`Listening on :${port}`));
}

const DRAIN_MS = 3000;
let server = null;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    server.closeIdleConnections && server.closeIdleConnections();
    const t = setTimeout(() => server.closeAllConnections && server.closeAllConnections(), DRAIN_MS);
    t.unref && t.unref();
  }
  try { await pool.end(); } catch (e) { console.error('[shutdown] pool.end failed', e.message); }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
