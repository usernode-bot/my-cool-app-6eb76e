const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

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
  // Answers a signed-out caller with signed_in: false and nothing else.
  '/api/wallet/me',
  // Both answer a signed-out caller with defaults (no run, the default
  // settings) and only reveal the caller's own data when signed in.
  '/api/game/run/state',
  '/api/settings',
]);
const PUBLIC_PREFIXES = ['/explorer-api/'];
// A party's state is readable like the open round's (a username, a room slug
// and a score per row). Joining and playing need an account.
const PUBLIC_API_PATTERNS = [/^\/api\/party\/[A-Za-z0-9]+\/state$/];

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

// ── Solo runs: a difficulty is a sequence of floors on the one drawn map ─────
// Floors are the same 11 rooms with only `rooms_left` of them in play (rooms
// are fenced off, not deleted, so the map, hotspots and roomGeo keep working
// and the 11-room single source of truth is not forked). Winning a floor means
// surviving the round in which rooms_left reaches zero.
const RUN_FLOORS = {
  novice:      [{ floor: 1, rooms: 11, pocong: 1 }],
  challenging: [{ floor: 2, rooms: 6,  pocong: 1 }],
  diehard:     [{ floor: 2, rooms: 3,  pocong: 2 }, { floor: 3, rooms: 3, pocong: 2 }],
};
// The Attic is the top floor, so it is named rather than numbered.
const FLOOR_LABELS = { 1: 'Floor 1', 2: 'Floor 2', 3: 'Attic' };
function floorLabel(floor) { return FLOOR_LABELS[floor] || ('Floor ' + floor); }
// Novice x1, Challenging x2, DieHard x3, applied where survivalPoints is used.
const DIFFICULTY_FACTOR = { novice: 1, challenging: 2, diehard: 3 };
const GHOSTS = ['pocong', 'sumala', 'raminom'];
const GHOST_LABELS = { pocong: 'Pocong', sumala: 'Sumala', raminom: 'Raminom' };
const DIFFICULTIES = Object.keys(RUN_FLOORS);
const DEFAULT_ROOMS_LEFT = RUN_FLOORS.novice[0].rooms;
// The same 11 slugs carry every floor, so a run's rooms are the first
// `rooms_left` of them. Fixed for a run, so a resumed run keeps its room set.
function runFloorsFor(difficulty) { return RUN_FLOORS[difficulty] || RUN_FLOORS.novice; }
function roomSlugsFor(rooms) { return ROOM_SLUGS.slice(0, Math.max(1, Math.min(rooms, ROOM_SLUGS.length))); }
// Draws `count` distinct rooms (without replacement): with 3 rooms and 2
// Pocong exactly one room is never entered, which is DieHard's "only 1 room
// survives".
function pickTargets(count, allowed) {
  const pool = (allowed && allowed.length ? allowed : ROOM_SLUGS).slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return pool.slice(0, Math.max(1, Math.min(count || 1, pool.length)));
}

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
    if (req.method === 'GET' && PUBLIC_API_PATTERNS.some((re) => re.test(req.path))) return next();
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

// Time-gated transitions. Runs before any read of the round so a browser that
// polls is enough to let the clock expire even with no admin. Idempotent, and
// the status is flipped with a conditional UPDATE so two concurrent requests
// cannot both pick a target.
const LIVE_STATUSES = ['hiding', 'hunt', 'resolved'];

// The shared open round (everyone in the app, all 11 rooms, one Pocong) and
// the Novice difficulty. A solo run on another difficulty gets its own
// sequence of rounds through openRunHidingRound.
async function currentOpenRound() {
  const r = await pool.query(
    `SELECT * FROM rounds WHERE run_id IS NULL ORDER BY round_number DESC LIMIT 1`);
  return r.rows[0] || null;
}

// The current shape of the shared open round (all 11 rooms, one Pocong,
// Novice). Every round a player sees is normalized to it at read time, so a
// row written by any earlier version of the game still renders correctly
// instead of showing stale fields. Columns are only ever raised, so an
// existing `ghost_enemy` choice survives.
async function normalizeRoundShape(round) {
  if (!round) return round;
  const fixes = {};
  if (round.pocong_count == null) fixes.pocong_count = 1;
  if (round.rooms_left == null) fixes.rooms_left = DEFAULT_ROOMS_LEFT;
  if (round.difficulty == null) fixes.difficulty = 'novice';
  if (round.floor == null) fixes.floor = 1;
  if (round.ghost_enemy == null) fixes.ghost_enemy = 'pocong';
  const keys = Object.keys(fixes);
  if (!keys.length) return round;
  const set = keys.map((k, i) => `${k}=$${i + 1}`).join(', ');
  await pool.query(`UPDATE rounds SET ${set} WHERE id=$${keys.length + 1}`,
    keys.map((k) => fixes[k]).concat([round.id]));
  return Object.assign({}, round, fixes);
}

// Opens the next hiding round after `afterRoundNumber` (0 for an empty table)
// for the shared open round, guarded so concurrent requests open it once.
async function openHidingRound(now, afterRoundNumber) {
  const ins = await pool.query(
    `INSERT INTO rounds (round_number, status, hiding_ends_at)
     SELECT $1, 'hiding', $2
     WHERE NOT EXISTS (SELECT 1 FROM rounds WHERE run_id IS NULL AND round_number > $3)`,
    [afterRoundNumber + 1, new Date(now.getTime() + HIDING_MS), afterRoundNumber]
  );
  return ins.rowCount > 0;
}

// The draw for one round: `pocong_count` distinct rooms. `allowed` fences the
// draw to a run's remaining rooms; the shared open round passes null (all 11).
function drawTargets(count, allowed) {
  return pickTargets(count || 1, allowed || null);
}

async function toHunt(round, now, allowed) {
  const targets = drawTargets(round.pocong_count, allowed);
  const upd = await pool.query(
    `UPDATE rounds SET status='hunt', target_room=$1, target_rooms=$2, hunt_ends_at=$3
     WHERE id=$4 AND status='hiding' RETURNING id`,
    [targets[0], targets, new Date(now.getTime() + HUNT_MS), round.id]
  );
  return upd.rows.length > 0;
}

async function toResolved(round, now) {
  const upd = await pool.query(
    `UPDATE rounds SET status='resolved', resolved_at=$1 WHERE id=$2 AND status='hunt' RETURNING id`,
    [now, round.id]
  );
  if (!upd.rows.length) return false;
  await resolveRound(round);
  return true;
}

async function runTransitions(now) {
  for (let i = 0; i < 4; i++) {
    const round = await currentOpenRound();
    if (!round) {
      // No round at all (a production database that never had one): open
      // round 1 so the game runs from the first load, in every environment.
      await openHidingRound(now, 0);
      continue;
    }

    // Self-heal from state this machine cannot advance. Production carried
    // rounds from the earlier betting version ('active' / 'resolving' /
    // 'completed', no deadlines): none of the branches below ever matched,
    // so no round opened and the countdown had nothing to count down from.
    // A legacy or unknown status is treated as finished (the row is left
    // untouched) and the next hiding round opens from it.
    if (!LIVE_STATUSES.includes(round.status)) {
      await openHidingRound(now, round.round_number);
      continue;
    }
    // A live round with no deadline can never expire: give it one now.
    if (round.status === 'hiding' && !round.hiding_ends_at) {
      await pool.query(
        `UPDATE rounds SET hiding_ends_at=$1 WHERE id=$2 AND status='hiding' AND hiding_ends_at IS NULL`,
        [new Date(now.getTime() + HIDING_MS), round.id]
      );
      continue;
    }
    if (round.status === 'hunt' && !round.hunt_ends_at) {
      await pool.query(
        `UPDATE rounds SET hunt_ends_at=$1 WHERE id=$2 AND status='hunt' AND hunt_ends_at IS NULL`,
        [now, round.id]
      );
      continue;
    }

    if (round.status === 'hiding' && now > new Date(round.hiding_ends_at)) {
      // Anyone who never locked a room is disqualified to the Spectator
      // Lounge. They have no hides row, so there is nothing to rewrite here:
      // a locked-in hide also carries outcome 'pending' until resolve, and
      // must NOT be caught. Disqualification is reported at read time.
      if (await toHunt(round, now, null)) continue;
      continue; // another request won the race
    }

    if (round.status === 'hunt' && round.hunt_ends_at && now > new Date(round.hunt_ends_at)) {
      if (await toResolved(round, now)) continue;
      continue;
    }

    // The resolved round is shown for RESULT_MS, then the next round opens.
    if (round.status === 'resolved' && (!round.resolved_at || now.getTime() >= new Date(round.resolved_at).getTime() + RESULT_MS)) {
      await openHidingRound(now, round.round_number);
      continue;
    }
    return;
  }
}

// Points for surviving a round. Shared by the open round, solo runs and party
// rounds. `difficulty` scales the base score (Novice x1, Challenging x2,
// DieHard x3); the open round and party rounds keep the x1 default.
function survivalPoints(hide, total, counts, streakBefore, difficulty) {
  const base = 100;
  const distance = 25 * (STEP_BY_SLUG[hide.room_slug] || 1);
  const scarcity = Math.min(300, Math.round(50 * total / Math.max(1, counts[hide.room_slug] || 1)));
  let points = Math.round((base + distance + scarcity) * Math.min(3, 1 + 0.1 * streakBefore));
  if (hide.daring_room_slug) points = Math.round(points * 1.5);
  const factor = DIFFICULTY_FACTOR[difficulty];
  if (factor && factor !== 1) points = Math.round(points * factor);
  return points;
}

// The rooms the round's Pocong entered. `target_rooms` (the full draw) is used
// when present; the single legacy `target_room` otherwise.
function roundTargets(round) {
  if (Array.isArray(round.target_rooms) && round.target_rooms.length) return round.target_rooms;
  return round.target_room ? [round.target_room] : [];
}

// `round` is the rounds row. A solo run (`run_id` set) gets the difficulty
// factor and advances its floor; the open round behaves as before.
async function resolveRound(round) {
  const targets = roundTargets(round);
  const hides = await pool.query(
    `SELECT id, user_id, username, room_slug, daring_room_slug FROM hides WHERE round_id=$1 AND outcome='pending'`,
    [round.id]
  );
  const counts = {};
  for (const h of hides.rows) counts[h.room_slug] = (counts[h.room_slug] || 0) + 1;
  const total = hides.rows.length;

  for (const h of hides.rows) {
    // A daring second pick doubles the exposure: the Pocong entering either
    // room is an elimination. Surviving both earns x1.5 on the round.
    const survived = !targets.includes(h.room_slug) && !targets.includes(h.daring_room_slug);
    let points = 0;
    if (survived) {
      const stats = await pool.query(`SELECT current_streak FROM player_stats WHERE user_id=$1`, [h.user_id]);
      const streakBefore = stats.rows[0] ? stats.rows[0].current_streak : 0;
      points = survivalPoints(h, total, counts, streakBefore, round.difficulty);
    }
    const outcome = survived ? 'survived' : 'eliminated';
    await pool.query(`UPDATE hides SET outcome=$1, points_awarded=$2 WHERE id=$3`, [outcome, points, h.id]);
    await applyStats(h.user_id, h.username, survived, points);
  }

  if (round.run_id) await advanceRun(round.run_id, round.id);
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
    const round = await normalizeRoundShape(roundRes.rows[0]);

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

    const roundPayload = {
      id: round.id,
      round_number: round.round_number,
      status: round.status,
      target_room: round.target_room,
      hiding_ends_at: round.hiding_ends_at,
      hunt_ends_at: round.hunt_ends_at,
    };
    // The start-page slice's extra round fields are appended AFTER the fields
    // that were already here, so a serialized round keeps the same leading
    // shape (the existing "auto-opens from a legacy round" check pins the
    // order of status/target_room/hiding_ends_at).
    roundPayload.target_rooms = roundTargets(round);
    roundPayload.difficulty = round.difficulty || 'novice';
    roundPayload.floor = round.floor || 1;
    roundPayload.rooms_left = round.rooms_left || DEFAULT_ROOMS_LEFT;
    roundPayload.ghost_enemy = round.ghost_enemy || 'pocong';
    res.json({
      round: roundPayload,
      my_hide: myHide,
      hides: hidesRes.rows,
      stats,
      server_now: req.now.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Wallet bind gate ─────────────────────────────────────────────────────────
// On top of the Homeroom iframe JWT (which stays the sign-in), a player binds
// the wallet Homeroom links to their account (req.user.usernode_pubkey) before
// they can hide or play a party. The bind consumes a one-time server-issued
// challenge. Homeroom does not yet let apps request signMessage from inside
// the frame, nor publish how to verify a ut1 signature, so until it does a
// bind without a signature is accepted as method 'linked' (the address comes
// from the platform-signed JWT). Flip SIGNING_REQUIRED once signing exists.
const SIGNING_REQUIRED = false;
const CHALLENGE_MS = 5 * 60 * 1000;

// The platform has not published the ut1 signature scheme (a platform report
// was drafted for in-app signMessage plus a verify scheme). Never guess an
// algorithm, and never accept the bridge's local mock signatures.
function verifyWalletSignature(_address, _message, signature) {
  if (typeof signature !== 'string' || signature.startsWith('mock_signature_')) return false;
  return false;
}

async function walletStatus(user) {
  const linked = user.usernode_pubkey || null;
  const r = await pool.query(
    `SELECT wallet_address, method, bound_at FROM wallet_bindings WHERE user_id=$1`,
    [user.id]
  );
  const binding = r.rows[0] || null;
  const bound = !!(binding && linked && binding.wallet_address === linked &&
    (!SIGNING_REQUIRED || binding.method === 'signature'));
  return { linked_wallet: linked, bound, binding, signing_required: SIGNING_REQUIRED };
}

async function requireBoundWallet(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const st = await walletStatus(req.user);
    if (!st.bound) return res.status(403).json({ error: 'wallet_not_bound' });
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/wallet/me', async (req, res) => {
  if (!req.user) {
    return res.json({ signed_in: false, linked_wallet: null, bound: false, binding: null, signing_required: SIGNING_REQUIRED });
  }
  try {
    res.json({ signed_in: true, ...(await walletStatus(req.user)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallet/challenge', async (req, res) => {
  const wallet = req.user.usernode_pubkey;
  if (!wallet) return res.status(400).json({ error: 'no_linked_wallet' });
  try {
    await pool.query(`DELETE FROM wallet_challenges WHERE expires_at < $1`, [new Date(req.now.getTime() - 24 * 3600 * 1000)]);
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(req.now.getTime() + CHALLENGE_MS);
    const message = [
      'Awas Ada Pocong wants to bind this wallet to your player.',
      'App: usernode:app:' + process.env.USERNODE_APP_ID,
      `User: ${req.user.username} (#${req.user.id})`,
      'Wallet: ' + wallet,
      'Nonce: ' + nonce,
      'Issued: ' + req.now.toISOString(),
      'This is not a payment and moves no coins.',
    ].join('\n');
    await pool.query(
      `INSERT INTO wallet_challenges (nonce, user_id, wallet_address, message, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [nonce, req.user.id, wallet, message, expiresAt]
    );
    res.json({ nonce, message, expires_at: expiresAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallet/bind', async (req, res) => {
  const { nonce, signature, pubkey } = req.body || {};
  if (typeof nonce !== 'string' || !nonce) return res.status(400).json({ error: 'challenge_invalid' });
  const hasSig = typeof signature === 'string' && signature.length > 0;
  if (!hasSig && SIGNING_REQUIRED) return res.status(400).json({ error: 'signature_required' });
  try {
    const ch = await pool.query(
      `UPDATE wallet_challenges SET used_at=$3
       WHERE nonce=$1 AND user_id=$2 AND used_at IS NULL AND expires_at > $3
       RETURNING wallet_address, message`,
      [nonce, req.user.id, req.now]
    );
    if (!ch.rows.length) return res.status(409).json({ error: 'challenge_invalid' });
    const { wallet_address, message } = ch.rows[0];
    if (!req.user.usernode_pubkey || wallet_address !== req.user.usernode_pubkey ||
        (pubkey != null && pubkey !== wallet_address)) {
      return res.status(409).json({ error: 'wallet_mismatch' });
    }
    if (hasSig && !verifyWalletSignature(wallet_address, message, signature)) {
      return res.status(401).json({ error: 'bad_signature' });
    }
    const method = hasSig ? 'signature' : 'linked';
    await pool.query(
      `INSERT INTO wallet_bindings (user_id, username, wallet_address, method, signed_message, signature, bound_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET username=EXCLUDED.username, wallet_address=EXCLUDED.wallet_address,
         method=EXCLUDED.method, signed_message=EXCLUDED.signed_message, signature=EXCLUDED.signature,
         bound_at=EXCLUDED.bound_at`,
      [req.user.id, req.user.username, wallet_address, method, message, hasSig ? signature : null, req.now]
    );
    res.json({ ok: true, signed_in: true, ...(await walletStatus(req.user)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Lock in a hiding room (authenticated) ────────────────────────────────────

app.post('/api/game/hide', requireBoundWallet, async (req, res) => {
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

app.post('/api/game/daring', requireBoundWallet, async (req, res) => {
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

// ── Party mode ───────────────────────────────────────────────────────────────
// A party is a private group that shares its own rounds, apart from the open
// round everyone plays. Any member starts a round; it then runs on the same
// clock as the open round (60s hiding, 6s hunt) and is scored with the same
// points formula into the party's own scoreboard. Points only, no stakes.

const PARTY_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PARTY_CODE_RE = /^[A-Z0-9]{4,8}$/;
const PARTY_MAX_MEMBERS = 12;

function newPartyCode() {
  let c = '';
  for (let i = 0; i < 5; i++) c += PARTY_CODE_CHARS[Math.floor(Math.random() * PARTY_CODE_CHARS.length)];
  return c;
}

async function findParty(rawCode) {
  const code = String(rawCode || '').toUpperCase();
  if (!PARTY_CODE_RE.test(code)) return null;
  const r = await pool.query(`SELECT * FROM parties WHERE code=$1`, [code]);
  return r.rows[0] || null;
}

async function isPartyMember(partyId, userId) {
  const r = await pool.query(`SELECT 1 FROM party_members WHERE party_id=$1 AND user_id=$2`, [partyId, userId]);
  return r.rows.length > 0;
}

async function latestPartyRound(partyId) {
  const r = await pool.query(
    `SELECT * FROM party_rounds WHERE party_id=$1 ORDER BY round_number DESC LIMIT 1`, [partyId]);
  return r.rows[0] || null;
}

// Opens the party's next hiding round unless one is already live. The
// UNIQUE (party_id, round_number) key stops two concurrent starts.
async function openPartyRound(partyId, now) {
  try {
    const ins = await pool.query(
      `INSERT INTO party_rounds (party_id, round_number, status, hiding_ends_at)
       SELECT $1::int, COALESCE(MAX(round_number), 0) + 1, 'hiding', $2::timestamptz
       FROM party_rounds WHERE party_id=$1::int
       HAVING NOT EXISTS (SELECT 1 FROM party_rounds WHERE party_id=$1::int AND status IN ('hiding','hunt'))`,
      [partyId, new Date(now.getTime() + HIDING_MS)]
    );
    return ins.rowCount > 0;
  } catch (err) {
    if (err.code === '23505') return false;
    throw err;
  }
}

async function partyToHunt(round, now) {
  const upd = await pool.query(
    `UPDATE party_rounds SET status='hunt', target_room=$1, hunt_ends_at=$2
     WHERE id=$3 AND status='hiding' RETURNING id`,
    [pickTarget(), new Date(now.getTime() + HUNT_MS), round.id]
  );
  return upd.rows.length > 0;
}

async function partyToResolved(round, now) {
  const upd = await pool.query(
    `UPDATE party_rounds SET status='resolved', resolved_at=$1 WHERE id=$2 AND status='hunt'
     RETURNING id, party_id, target_room`,
    [now, round.id]
  );
  if (upd.rows.length) await resolvePartyRound(upd.rows[0]);
  return upd.rows.length > 0;
}

// Same lazy, time-gated pattern as runTransitions. A resolved party round
// stays resolved until a member starts the next one.
async function runPartyTransitions(partyId, now) {
  for (let i = 0; i < 3; i++) {
    const round = await latestPartyRound(partyId);
    if (!round) return;
    if (round.status === 'hiding' && now > new Date(round.hiding_ends_at)) { await partyToHunt(round, now); continue; }
    if (round.status === 'hunt' && now > new Date(round.hunt_ends_at)) { await partyToResolved(round, now); continue; }
    return;
  }
}

async function resolvePartyRound(round) {
  const hides = await pool.query(
    `SELECT id, user_id, room_slug, daring_room_slug FROM party_hides WHERE party_round_id=$1 AND outcome='pending'`,
    [round.id]
  );
  const counts = {};
  for (const h of hides.rows) counts[h.room_slug] = (counts[h.room_slug] || 0) + 1;
  const total = hides.rows.length;
  for (const h of hides.rows) {
    const survived = h.room_slug !== round.target_room && h.daring_room_slug !== round.target_room;
    const m = await pool.query(
      `SELECT streak FROM party_members WHERE party_id=$1 AND user_id=$2`, [round.party_id, h.user_id]);
    const streakBefore = m.rows[0] ? m.rows[0].streak : 0;
    const points = survived ? survivalPoints(h, total, counts, streakBefore) : 0;
    await pool.query(
      `UPDATE party_hides SET outcome=$1, points_awarded=$2 WHERE id=$3`,
      [survived ? 'survived' : 'eliminated', points, h.id]
    );
    await pool.query(
      `UPDATE party_members SET
         score = score + $3,
         best_round = GREATEST(best_round, $3),
         streak = CASE WHEN $4 THEN streak + 1 ELSE 0 END,
         rounds_survived = rounds_survived + CASE WHEN $4 THEN 1 ELSE 0 END
       WHERE party_id=$1 AND user_id=$2`,
      [round.party_id, h.user_id, points, survived]
    );
  }
}

app.post('/api/party', requireBoundWallet, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required', action: 'create a party' });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newPartyCode();
      const ins = await pool.query(
        `INSERT INTO parties (code, created_by_user_id, created_by_username)
         VALUES ($1,$2,$3) ON CONFLICT (code) DO NOTHING RETURNING id, code`,
        [code, req.user.id, req.user.username]
      );
      if (!ins.rows.length) continue;
      await pool.query(
        `INSERT INTO party_members (party_id, user_id, username) VALUES ($1,$2,$3)
         ON CONFLICT (party_id, user_id) DO NOTHING`,
        [ins.rows[0].id, req.user.id, req.user.username]
      );
      return res.json({ ok: true, code: ins.rows[0].code });
    }
    res.status(503).json({ error: 'Could not create a party. Try again.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/party/:code/join', requireBoundWallet, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required', action: 'join a party' });
  try {
    const party = await findParty(req.params.code);
    if (!party) return res.status(404).json({ error: 'No party with that code' });
    if (!(await isPartyMember(party.id, req.user.id))) {
      const n = await pool.query(`SELECT COUNT(*)::int AS n FROM party_members WHERE party_id=$1`, [party.id]);
      if (n.rows[0].n >= PARTY_MAX_MEMBERS) return res.status(409).json({ error: 'This party is full' });
      await pool.query(
        `INSERT INTO party_members (party_id, user_id, username) VALUES ($1,$2,$3)
         ON CONFLICT (party_id, user_id) DO NOTHING`,
        [party.id, req.user.id, req.user.username]
      );
    }
    res.json({ ok: true, code: party.code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/party/:code/state', async (req, res) => {
  try {
    const party = await findParty(req.params.code);
    if (!party) return res.status(404).json({ error: 'No party with that code' });
    await runPartyTransitions(party.id, req.now);

    const membersRes = await pool.query(
      `SELECT user_id, username, score, best_round, streak, rounds_survived, joined_at FROM party_members
       WHERE party_id=$1 ORDER BY score DESC, joined_at ASC`,
      [party.id]
    );
    const round = await latestPartyRound(party.id);
    const hides = round ? (await pool.query(
      `SELECT user_id, username, room_slug, outcome, points_awarded FROM party_hides WHERE party_round_id=$1`,
      [round.id]
    )).rows : [];
    const lockedIds = new Set(hides.map((h) => h.user_id));
    const me = req.user ? membersRes.rows.find((m) => m.user_id === req.user.id) : null;

    let myHide = null;
    if (me && round) {
      const mh = await pool.query(
        `SELECT room_slug, daring_room_slug, outcome, points_awarded FROM party_hides
         WHERE party_round_id=$1 AND user_id=$2`,
        [round.id, req.user.id]
      );
      myHide = mh.rows[0] || null;
      // Only a member who was in the party while it was hiding timed out; one
      // who joined later simply watched.
      const joinedInTime = new Date(me.joined_at) <= new Date(round.hiding_ends_at);
      if (!myHide && round.status !== 'hiding' && joinedInTime) {
        myHide = { room_slug: null, daring_room_slug: null, outcome: 'disqualified', points_awarded: 0 };
      }
    }

    res.json({
      party: {
        code: party.code,
        created_by: party.created_by_username,
        is_member: !!me,
        max_members: PARTY_MAX_MEMBERS,
        members: membersRes.rows.map((m) => ({
          username: m.username,
          score: Number(m.score),
          streak: m.streak,
          locked: !!(round && round.status === 'hiding' && lockedIds.has(m.user_id)),
        })),
      },
      round: round ? {
        id: round.id,
        round_number: round.round_number,
        status: round.status,
        target_room: round.target_room,
        hiding_ends_at: round.hiding_ends_at,
        hunt_ends_at: round.hunt_ends_at,
        resolved_at: round.resolved_at,
      } : null,
      my_hide: myHide,
      hides: hides.map((h) => ({ username: h.username, room_slug: h.room_slug, outcome: h.outcome, points_awarded: h.points_awarded })),
      stats: me ? { total_score: Number(me.score), best_score: me.best_round, current_streak: me.streak } : null,
      result_ms: RESULT_MS,
      server_now: req.now.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared guard for party writes: the party exists and the caller is in it.
async function partyForMember(req, res, action) {
  if (!req.user) { res.status(401).json({ error: 'account_required', action }); return null; }
  const party = await findParty(req.params.code);
  if (!party) { res.status(404).json({ error: 'No party with that code' }); return null; }
  if (!(await isPartyMember(party.id, req.user.id))) { res.status(403).json({ error: 'Join the party first' }); return null; }
  return party;
}

app.post('/api/party/:code/start', requireBoundWallet, async (req, res) => {
  try {
    const party = await partyForMember(req, res, 'start a party round');
    if (!party) return;
    await runPartyTransitions(party.id, req.now);
    const opened = await openPartyRound(party.id, req.now);
    if (!opened) return res.status(409).json({ error: 'A round is already running' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function livePartyHidingRound(partyId, now) {
  await runPartyTransitions(partyId, now);
  const round = await latestPartyRound(partyId);
  if (!round || round.status !== 'hiding' || now > new Date(round.hiding_ends_at)) return null;
  return round;
}

app.post('/api/party/:code/hide', requireBoundWallet, async (req, res) => {
  const { room_slug } = req.body || {};
  try {
    const party = await partyForMember(req, res, 'hide in a room');
    if (!party) return;
    if (!ROOM_SLUGS.includes(room_slug)) return res.status(400).json({ error: 'Invalid room' });
    const round = await livePartyHidingRound(party.id, req.now);
    if (!round) return res.status(409).json({ error: 'No hiding phase' });
    const hide = await pool.query(
      `INSERT INTO party_hides (party_round_id, user_id, username, room_slug, locked_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING room_slug, outcome`,
      [round.id, req.user.id, req.user.username, room_slug, req.now]
    );
    res.json({ ok: true, hide: hide.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already locked' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/party/:code/daring', requireBoundWallet, async (req, res) => {
  const { room_slug } = req.body || {};
  try {
    const party = await partyForMember(req, res, 'dare a second room');
    if (!party) return;
    if (!ROOM_SLUGS.includes(room_slug)) return res.status(400).json({ error: 'Invalid room' });
    const round = await livePartyHidingRound(party.id, req.now);
    if (!round) return res.status(409).json({ error: 'No hiding phase' });
    const mine = await pool.query(
      `SELECT id, room_slug, daring_room_slug FROM party_hides WHERE party_round_id=$1 AND user_id=$2`,
      [round.id, req.user.id]
    );
    if (!mine.rows.length) return res.status(409).json({ error: 'Lock a hiding room first' });
    if (mine.rows[0].room_slug === room_slug) return res.status(400).json({ error: 'Pick a different room' });
    const upd = await pool.query(
      `UPDATE party_hides SET daring_room_slug=$1 WHERE id=$2 AND daring_room_slug IS NULL
       RETURNING room_slug, daring_room_slug, outcome`,
      [room_slug, mine.rows[0].id]
    );
    if (!upd.rows.length) return res.status(409).json({ error: 'Already dared' });
    res.json({ ok: true, hide: upd.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staging only: step the party's round on one phase per click, like the open
// round's Next Phase button. In production the clock does it.
app.post('/api/party/:code/advance', async (req, res) => {
  if (!IS_STAGING) return res.status(403).json({ error: 'Staging only' });
  try {
    const party = await partyForMember(req, res, 'advance the round');
    if (!party) return;
    const round = await latestPartyRound(party.id);
    if (round && round.status === 'hiding') await partyToHunt(round, req.now);
    else if (round && round.status === 'hunt') await partyToResolved(round, req.now);
    else await openPartyRound(party.id, req.now);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Solo runs: Play Game's three difficulties ────────────────────────────────
// A run is a sequence of rounds on its own clock, apart from the shared open
// round, so players on different difficulties never share one round. Novice is
// the shared open round (all 11 rooms, one Pocong); Challenging and DieHard get
// their own run whose rounds are fenced to `rooms_left` of the same 11 slugs.

async function activeRun(userId) {
  const r = await pool.query(
    `SELECT * FROM runs WHERE user_id=$1 AND status='active'
     ORDER BY updated_at DESC LIMIT 1`, [userId]);
  return r.rows[0] || null;
}

// Sumala is unlocked once a floor >= 2 has been won, Raminom once a floor >= 3
// has. Derived from its own wins, not stored, so no seed can fabricate the
// signal this code reads.
async function unlockedGhosts(userId) {
  const r = await pool.query(`SELECT MAX(floor) AS best FROM wins WHERE user_id=$1`, [userId]);
  const best = r.rows[0] && r.rows[0].best ? Number(r.rows[0].best) : 0;
  const unlocked = { pocong: true, sumala: best >= 2, raminom: best >= 3 };
  return unlocked;
}

function ghostFor(settingsGhost, unlocked) {
  const g = GHOSTS.includes(settingsGhost) ? settingsGhost : 'pocong';
  return unlocked[g] ? g : 'pocong';
}

async function playerSettings(userId) {
  const r = await pool.query(`SELECT * FROM player_settings WHERE user_id=$1`, [userId]);
  return r.rows[0] || { sound_volume: 50, ghost_enemy: 'pocong' };
}

// Opens a run round: `rooms_left` of the same 11 slugs, `pocong_count` Pocong,
// the chosen ghost (clamped to an unlocked one), on the run's own clock.
async function openRunHidingRound(run, now) {
  try {
    const ins = await pool.query(
      `INSERT INTO rounds (round_number, run_id, difficulty, floor, ghost_enemy, pocong_count, rooms_left, status, hiding_ends_at)
       SELECT COALESCE(MAX(round_number), 0) + 1, $1, $2, $3, $4, $5, $6, 'hiding', $7
       FROM rounds
       HAVING NOT EXISTS (SELECT 1 FROM rounds WHERE run_id=$1 AND status IN ('hiding','hunt'))`,
      [run.id, run.difficulty, run.floor, run.ghost_enemy, run.pocong_count, run.rooms_left,
       new Date(now.getTime() + HIDING_MS)]
    );
    return ins.rowCount > 0;
  } catch (err) {
    if (err.code === '23505') return false;
    throw err;
  }
}

async function currentRunRound(runId) {
  const r = await pool.query(
    `SELECT * FROM rounds WHERE run_id=$1 ORDER BY round_number DESC LIMIT 1`, [runId]);
  return r.rows[0] || null;
}

// On resolve, a run's floor advances when its `rooms_left` reaches zero. The
// player clears the floor by surviving the round in which the whole floor was
// in play (they were not in the room the Pocong entered). DieHard then moves
// Floor 2 to the Attic and refills; the others win the run.
async function advanceRun(runId, roundId) {
  const rr = await pool.query(`SELECT * FROM runs WHERE id=$1`, [runId]);
  const run = rr.rows[0];
  if (!run || run.status !== 'active') return;
  const floors = runFloorsFor(run.difficulty);
  const idx = floors.findIndex((f) => f.floor === run.floor);
  if (idx === -1) return;
  const mine = await pool.query(
    `SELECT outcome, username FROM hides WHERE round_id=$1 AND user_id=$2`, [roundId, run.user_id]);
  const survived = !!(mine.rows[0] && mine.rows[0].outcome === 'survived');

  if (survived) {
    if (idx + 1 < floors.length) {
      const next = floors[idx + 1];
      await pool.query(
        `UPDATE runs SET floor=$1, rooms_left=$2, pocong_count=$3, status='active', updated_at=NOW() WHERE id=$4`,
        [next.floor, next.rooms, next.pocong, run.id]);
      return;
    }
    // Cleared the last floor: the run is won and the win is written to the
    // winner history (points = the run's points, summed from its hides rows).
    const pts = await pool.query(
      `SELECT COALESCE(SUM(points_awarded), 0)::bigint AS pts FROM hides
       WHERE user_id=$1 AND round_id IN (SELECT id FROM rounds WHERE run_id=$2)`,
      [run.user_id, run.id]);
    const points = Number(pts.rows[0].pts || 0);
    // `wins.username` is NOT NULL: take it from the round's own hide row, which
    // always carries the name the player played under.
    const winner = (mine.rows[0] && mine.rows[0].username) || run.username || 'player';
    await pool.query(
      `INSERT INTO wins (user_id, username, points, difficulty, ghost_enemy, floor)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [run.user_id, winner, points, run.difficulty, run.ghost_enemy, run.floor]);
    await pool.query(`UPDATE runs SET status='won', updated_at=NOW() WHERE id=$1`, [run.id]);
    return;
  }

  // Eliminated: the run is lost but stays saved, so the next START resumes the
  // same floor with the rooms it had left.
  await pool.query(`UPDATE runs SET status='lost', updated_at=NOW() WHERE id=$1 AND status='active'`, [run.id]);
}

// The run's own time-gated transitions, in the shape of runTransitions. After a
// floor resolves and the run is still active (DieHard's Floor 2 cleared, ready
// for the Attic), the next floor's hiding round opens once RESULT_MS has shown
// the result.
async function runRunTransitions(run, now) {
  for (let i = 0; i < 4; i++) {
    const round = await currentRunRound(run.id);
    if (!round) return;
    if (round.status === 'hiding' && (!round.hiding_ends_at || now > new Date(round.hiding_ends_at))) {
      if (!round.hiding_ends_at) {
        await pool.query(`UPDATE rounds SET hiding_ends_at=$1 WHERE id=$2`, [new Date(now.getTime() + HIDING_MS), round.id]);
        continue;
      }
      await toHunt(round, now, roomSlugsFor(round.rooms_left));
      continue;
    }
    if (round.status === 'hunt' && round.hunt_ends_at && now > new Date(round.hunt_ends_at)) {
      await toResolved(round, now);
      continue;
    }
    if (round.status === 'resolved' && round.resolved_at &&
        now.getTime() >= new Date(round.resolved_at).getTime() + RESULT_MS) {
      const fresh = await pool.query(`SELECT * FROM runs WHERE id=$1`, [run.id]);
      if (fresh.rows[0] && fresh.rows[0].status === 'active') {
        await openRunHidingRound(fresh.rows[0], now);
        continue;
      }
    }
    return;
  }
}

async function runPayload(run, round, req) {
  const hides = round ? (await pool.query(
    `SELECT username, room_slug, outcome, points_awarded FROM hides WHERE round_id=$1`, [round.id])).rows : [];
  let myHide = null, stats = null;
  if (req.user) {
    const mh = round ? await pool.query(
      `SELECT room_slug, daring_room_slug, outcome, points_awarded FROM hides WHERE round_id=$1 AND user_id=$2`,
      [round.id, req.user.id]) : { rows: [] };
    myHide = mh.rows[0] || null;
    if (round && !myHide && round.status !== 'hiding') {
      myHide = { room_slug: null, daring_room_slug: null, outcome: 'disqualified', points_awarded: 0 };
    }
    const st = await pool.query(`SELECT * FROM player_stats WHERE user_id=$1`, [req.user.id]);
    stats = st.rows[0] || null;
  }
  return {
    run: { difficulty: run.difficulty, floor: run.floor, rooms_left: run.rooms_left,
           pocong_count: run.pocong_count, ghost_enemy: run.ghost_enemy, status: run.status },
    round: round ? {
      id: round.id, round_number: round.round_number, status: round.status,
      target_room: round.target_room, target_rooms: roundTargets(round),
      hiding_ends_at: round.hiding_ends_at, hunt_ends_at: round.hunt_ends_at,
      resolved_at: round.resolved_at,
    } : null,
    my_hide: myHide, hides, stats,
    result_ms: RESULT_MS,
    server_now: req.now.toISOString(),
  };
}

// The caller's active run and its current round.
app.get('/api/game/run/state', async (req, res) => {
  const empty = { run: null, round: null, my_hide: null, hides: [], stats: null,
    difficulty_options: DIFFICULTIES, result_ms: RESULT_MS, server_now: req.now.toISOString() };
  if (!req.user) return res.json(empty); // signed out: no run, nothing of anyone's
  try {
    const run = await activeRun(req.user.id);
    if (!run) return res.json(empty);
    await runRunTransitions(run, req.now);
    const fresh = await activeRun(req.user.id) || run;
    const round = await currentRunRound(fresh.id);
    const payload = await runPayload(fresh, round, req);
    payload.difficulty_options = DIFFICULTIES;
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// START. Resumes the saved run of that difficulty if one is active, otherwise
// opens the difficulty's first floor. Novice's first floor is the shared open
// round: no run is created and nothing is resumed.
app.post('/api/game/run/start', requireBoundWallet, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required', action: 'play a run' });
  const { difficulty } = req.body || {};
  if (!DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: 'Unknown difficulty' });
  try {
    if (difficulty === 'novice') {
      await runTransitions(req.now);
      const round = await currentOpenRound();
      return res.json({ ok: true, difficulty, run: null, round: round ? { id: round.id, status: round.status } : null });
    }
    const floors = runFloorsFor(difficulty);
    // The saved run of this difficulty: resumable whether it is still active or
    // was lost (eliminated runs stay saved on their floor).
    let run = await pool.query(
      `SELECT * FROM runs WHERE user_id=$1 AND difficulty=$2 AND status IN ('active','lost')
       ORDER BY updated_at DESC LIMIT 1`, [req.user.id, difficulty]);
    run = run.rows[0] || null;
    if (run && run.username !== req.user.username) {
      await pool.query(`UPDATE runs SET username=$1, updated_at=NOW() WHERE id=$2`,
        [req.user.username, run.id]);
      run.username = req.user.username;
    }
    const unlocked = await unlockedGhosts(req.user.id);
    const ghost = ghostFor((await playerSettings(req.user.id)).ghost_enemy, unlocked);

    // Only one run is active at a time: a START on another difficulty parks the
    // current one as lost, so switching back later resumes it.
    if (!run || run.status !== 'active') {
      await pool.query(
        `UPDATE runs SET status='lost', updated_at=NOW() WHERE user_id=$1 AND status='active'
         AND (difficulty <> $2 OR id <> $3)`, [req.user.id, difficulty, run ? run.id : -1]);
    }
    if (run && run.status !== 'active') {
      await pool.query(`UPDATE runs SET status='active', ghost_enemy=$1, updated_at=NOW() WHERE id=$2`, [ghost, run.id]);
      run = (await pool.query(`SELECT * FROM runs WHERE id=$1`, [run.id])).rows[0];
    }
    if (!run) {
      const first = floors[0];
      const ins = await pool.query(
        `INSERT INTO runs (user_id, username, difficulty, floor, rooms_left, pocong_count, ghost_enemy, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *`,
        [req.user.id, req.user.username, difficulty, first.floor, first.rooms, first.pocong, ghost]);
      run = ins.rows[0];
    } else {
      await pool.query(`UPDATE runs SET ghost_enemy=$1, updated_at=NOW() WHERE id=$2`, [ghost, run.id]);
      run.ghost_enemy = ghost;
    }

    // Open the run's first hiding round unless one is already live (a resolved
    // floor is left to show for RESULT_MS; runRunTransitions opens its next one).
    await runRunTransitions(run, req.now);
    const cur = await currentRunRound(run.id);
    if (!cur) await openRunHidingRound(run, req.now);
    res.json({ ok: true, difficulty });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shared guard for a run's writes: the caller has an active run and it is live.
async function liveRunHidingRound(req, res) {
  if (!req.user) { res.status(401).json({ error: 'account_required', action: 'hide in a room' }); return null; }
  const run = await activeRun(req.user.id);
  if (!run) { res.status(409).json({ error: 'No run is on' }); return null; }
  await runRunTransitions(run, req.now);
  const round = await currentRunRound(run.id);
  if (!round || round.status !== 'hiding' || req.now > new Date(round.hiding_ends_at)) {
    res.status(409).json({ error: 'No hiding phase' }); return null;
  }
  return { run, round };
}

app.post('/api/game/run/hide', requireBoundWallet, async (req, res) => {
  const { room_slug } = req.body || {};
  try {
    const live = await liveRunHidingRound(req, res);
    if (!live) return;
    const allowed = roomSlugsFor(live.round.rooms_left);
    if (!ROOM_SLUGS.includes(room_slug)) return res.status(400).json({ error: 'Invalid room' });
    if (!allowed.includes(room_slug)) return res.status(400).json({ error: 'That room is not on this floor' });
    const hide = await pool.query(
      `INSERT INTO hides (user_id, username, round_id, room_slug, locked_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING room_slug, outcome`,
      [req.user.id, req.user.username, live.round.id, room_slug, req.now]);
    res.json({ ok: true, hide: hide.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already locked' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/game/run/daring', requireBoundWallet, async (req, res) => {
  const { room_slug } = req.body || {};
  try {
    const live = await liveRunHidingRound(req, res);
    if (!live) return;
    const allowed = roomSlugsFor(live.round.rooms_left);
    if (!ROOM_SLUGS.includes(room_slug)) return res.status(400).json({ error: 'Invalid room' });
    if (!allowed.includes(room_slug)) return res.status(400).json({ error: 'That room is not on this floor' });
    const mine = await pool.query(
      `SELECT id, room_slug, daring_room_slug FROM hides WHERE round_id=$1 AND user_id=$2`,
      [live.round.id, req.user.id]);
    if (!mine.rows.length) return res.status(409).json({ error: 'Lock a hiding room first' });
    if (mine.rows[0].daring_room_slug) return res.status(409).json({ error: 'Already dared' });
    if (mine.rows[0].room_slug === room_slug) return res.status(400).json({ error: 'Pick a different room' });
    const upd = await pool.query(
      `UPDATE hides SET daring_room_slug=$1 WHERE id=$2 AND daring_room_slug IS NULL
       RETURNING room_slug, daring_room_slug, outcome`,
      [room_slug, mine.rows[0].id]);
    if (!upd.rows.length) return res.status(409).json({ error: 'Already dared' });
    res.json({ ok: true, hide: upd.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Staging only: step the run one phase per click, like the open round's button.
app.post('/api/game/run/advance', async (req, res) => {
  if (!IS_STAGING) return res.status(403).json({ error: 'Staging only' });
  if (!req.user) return res.status(401).json({ error: 'account_required', action: 'advance the round' });
  try {
    const run = await activeRun(req.user.id);
    if (!run) return res.status(409).json({ error: 'No run is on' });
    const round = await currentRunRound(run.id);
    if (round && round.status === 'hiding') await toHunt(round, req.now, roomSlugsFor(round.rooms_left));
    else if (round && round.status === 'hunt') await toResolved(round, req.now);
    else {
      const fresh = await activeRun(req.user.id) || run;
      if (fresh.status === 'active') await openRunHidingRound(fresh, req.now);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Player settings: the sound slider and the ghost enemy ────────────────────

app.get('/api/settings', async (req, res) => {
  // Signed out, answer the app defaults (nothing of anyone's): sound 50 and
  // Pocong, with Sumala and Raminom locked. The page keeps them client-side
  // until the player signs in.
  if (!req.user) {
    return res.json({
      sound_volume: 50, ghost_enemy: 'pocong',
      ghosts: GHOSTS.map((g) => ({ key: g, label: GHOST_LABELS[g], unlocked: g === 'pocong' })),
    });
  }
  try {
    const s = await playerSettings(req.user.id);
    const unlocked = await unlockedGhosts(req.user.id);
    res.json({
      sound_volume: s.sound_volume,
      ghost_enemy: ghostFor(s.ghost_enemy, unlocked),
      ghosts: GHOSTS.map((g) => ({ key: g, label: GHOST_LABELS[g], unlocked: !!unlocked[g] })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required', action: 'save your settings' });
  const body = req.body || {};
  try {
    const cur = await playerSettings(req.user.id);
    let volume = cur.sound_volume;
    if (body.sound_volume !== undefined) {
      volume = Number(body.sound_volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
        return res.status(400).json({ error: 'Sound must be between 0 and 100' });
      }
      volume = Math.round(volume);
    }
    let ghost = cur.ghost_enemy;
    if (body.ghost_enemy !== undefined) {
      if (!GHOSTS.includes(body.ghost_enemy)) return res.status(400).json({ error: 'Unknown ghost' });
      const unlocked = await unlockedGhosts(req.user.id);
      ghost = ghostFor(body.ghost_enemy, unlocked); // clamp a locked ghost back to pocong
    }
    await pool.query(
      `INSERT INTO player_settings (user_id, username, sound_volume, ghost_enemy, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (user_id) DO UPDATE SET username=EXCLUDED.username,
         sound_volume=EXCLUDED.sound_volume, ghost_enemy=EXCLUDED.ghost_enemy, updated_at=NOW()`,
      [req.user.id, req.user.username, volume, ghost]);
    const unlocked = await unlockedGhosts(req.user.id);
    res.json({
      ok: true,
      sound_volume: volume,
      ghost_enemy: ghostFor(ghost, unlocked),
      ghosts: GHOSTS.map((g) => ({ key: g, label: GHOST_LABELS[g], unlocked: !!unlocked[g] })),
    });
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
    // Winner history: every cleared run, newest first.
    const w = await pool.query(`
      SELECT username, points, difficulty, ghost_enemy, floor, won_at
      FROM wins
      ORDER BY won_at DESC, points DESC
      LIMIT 20
    `);
    res.json({ leaderboard: rows, winners: w.rows });
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

  // ── Solo runs: difficulty, floor and the rooms left in play. All default,
  // so every existing row (the shared open round) keeps working.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      difficulty VARCHAR(12) NOT NULL DEFAULT 'novice',
      floor INTEGER NOT NULL DEFAULT 1,
      rooms_left INTEGER NOT NULL DEFAULT 11,
      pocong_count INTEGER NOT NULL DEFAULT 1,
      ghost_enemy VARCHAR(16) NOT NULL DEFAULT 'pocong',
      status VARCHAR(12) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS ghost_enemy VARCHAR(16) NOT NULL DEFAULT 'pocong'`);
  // One open run per user (a differing START parks the current one as lost).
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS runs_active_user ON runs (user_id) WHERE status='active'`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS run_id INTEGER REFERENCES runs(id)`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS difficulty VARCHAR(12) DEFAULT 'novice'`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS floor INTEGER DEFAULT 1`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS ghost_enemy VARCHAR(16) DEFAULT 'pocong'`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS pocong_count INTEGER DEFAULT 1`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS rooms_left INTEGER`);
  await pool.query(`ALTER TABLE rounds ADD COLUMN IF NOT EXISTS target_rooms TEXT[]`);

  // ── Winner history: this is the leaderboard the app shows. Public: a
  // username, a difficulty, a ghost and a score.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      points BIGINT NOT NULL DEFAULT 0,
      difficulty VARCHAR(12) NOT NULL DEFAULT 'novice',
      ghost_enemy VARCHAR(16) NOT NULL DEFAULT 'pocong',
      floor INTEGER NOT NULL DEFAULT 1,
      won_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS wins_points_won ON wins (points DESC, won_at DESC)`);

  // ── Player settings: a sound level and a ghost choice. Public (neither is
  // sensitive); it holds per-account data, so seeding must never write a row
  // for whoever opens the preview.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_settings (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      sound_volume INTEGER NOT NULL DEFAULT 50,
      ghost_enemy VARCHAR(16) NOT NULL DEFAULT 'pocong',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

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

  // ── Party mode tables. All public: a party code, usernames, room slugs and
  // scores, the same kind of rows as the open round.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parties (
      id SERIAL PRIMARY KEY,
      code VARCHAR(8) NOT NULL UNIQUE,
      created_by_user_id INTEGER NOT NULL,
      created_by_username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS party_members (
      party_id INTEGER NOT NULL REFERENCES parties(id),
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      score BIGINT NOT NULL DEFAULT 0,
      best_round INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      rounds_survived INTEGER NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (party_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS party_rounds (
      id SERIAL PRIMARY KEY,
      party_id INTEGER NOT NULL REFERENCES parties(id),
      round_number INTEGER NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'hiding',
      target_room VARCHAR(100),
      hiding_ends_at TIMESTAMPTZ NOT NULL,
      hunt_ends_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (party_id, round_number)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS party_hides (
      id SERIAL PRIMARY KEY,
      party_round_id INTEGER NOT NULL REFERENCES party_rounds(id),
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      room_slug VARCHAR(100) NOT NULL,
      daring_room_slug VARCHAR(100),
      locked_at TIMESTAMPTZ DEFAULT NOW(),
      outcome VARCHAR(20) NOT NULL DEFAULT 'pending',
      points_awarded INTEGER NOT NULL DEFAULT 0,
      UNIQUE (party_round_id, user_id)
    )
  `);

  // ── Wallet bind gate tables. Private: they tie a user to a wallet (auth
  // material), so staging copies the schema without the rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_bindings (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      wallet_address VARCHAR(128) NOT NULL,
      method VARCHAR(16) NOT NULL,
      signed_message TEXT,
      signature TEXT,
      bound_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE wallet_bindings IS 'staging:private'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_challenges (
      nonce VARCHAR(64) PRIMARY KEY,
      user_id INTEGER NOT NULL,
      wallet_address VARCHAR(128) NOT NULL,
      message TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    )
  `);
  await pool.query(`COMMENT ON TABLE wallet_challenges IS 'staging:private'`);

  // ── Staging seed data ─────────────────────────────────────────────────────
  if (IS_STAGING) {
    // Fake players' bindings (background data only; never the viewer's).
    const fakeBindings = [
      [900001, 'staging-demo-user'], [900002, 'staging-user-01'], [900003, 'staging-user-02'],
      [900004, 'staging-user-03'], [900005, 'staging-user-04'],
    ];
    for (const [uid, username] of fakeBindings) {
      await pool.query(
        `INSERT INTO wallet_bindings (user_id, username, wallet_address, method)
         VALUES ($1,$2,$3,'linked') ON CONFLICT (user_id) DO NOTHING`,
        [uid, username, 'ut1staging' + uid]
      );
    }
    const existing = await pool.query(`SELECT COUNT(*) FROM rounds`);
    if (existing.rows[0].count === '0') {
      const now = new Date();
      // Seed the shape production carried before the hide-and-seek rebuild: a
      // finished round from the old betting state machine as the latest row,
      // with no deadline. The recovery in runTransitions has to open round 6
      // from it, exactly as a production boot does; the figures below are
      // then attached to the round it opened.
      await pool.query(
        `INSERT INTO rounds (round_number, status, winner_room, completed_at)
         VALUES (5, 'completed', 'kamar-utama', $1)`,
        [new Date(now.getTime() - 60 * 1000)]
      );
      await runTransitions(now);
      const r = await pool.query(`SELECT id FROM rounds WHERE status='hiding' ORDER BY round_number DESC LIMIT 1`);
      const roundId = r.rows.length ? r.rows[0].id : null;
      const seeded = roundId === null ? [] : [
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
    // Winner history so the winner-history card renders with rows instead of
    // its empty state. Fake identities only, and never the viewer's: a run, a
    // settings row or a win for the preview's own account would fabricate the
    // signal the run and unlock code reads.
    const haveWins = await pool.query(`SELECT COUNT(*) FROM wins`);
    if (haveWins.rows[0].count === '0') {
      const now0 = new Date();
      const wins = [
        [900001, 'staging-demo-user', 10000, 'diehard',     'raminom', 3, -6 * 60],
        [900003, 'staging-user-02',    3150, 'diehard',     'sumala',  3, -14 * 60],
        [900002, 'staging-user-01',    2600, 'challenging', 'sumala',  2, -52 * 60],
        [900004, 'staging-user-03',    1480, 'challenging', 'pocong',  2, -95 * 60],
        [900005, 'staging-user-04',     760, 'novice',      'pocong',  1, -140 * 60],
        [900001, 'staging-demo-user',   520, 'novice',      'pocong',  1, -200 * 60],
      ];
      for (const [uid, username, points, difficulty, ghost, floor, minsAgo] of wins) {
        await pool.query(
          `INSERT INTO wins (user_id, username, points, difficulty, ghost_enemy, floor, won_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [uid, username, points, difficulty, ghost, floor, new Date(now0.getTime() + minsAgo * 60 * 1000)]);
      }
    }

    // A demo party, DEMO1, with fake members, scores and one finished round,
    // so the party screen has a scoreboard and figures. Anyone opening the
    // preview joins it like any other party; nobody real is seeded into it.
    const demo = await pool.query(
      `INSERT INTO parties (code, created_by_user_id, created_by_username)
       VALUES ('DEMO1', 900001, 'staging-demo-user') ON CONFLICT (code) DO NOTHING RETURNING id`
    );
    if (demo.rows.length) {
      const partyId = demo.rows[0].id;
      const members = [
        [900001, 'staging-demo-user', 860, 420, 2],
        [900002, 'staging-user-01', 610, 380, 1],
        [900003, 'staging-user-02', 340, 340, 0],
        [900004, 'staging-user-03', 0, 0, 0],
      ];
      for (const [uid, username, score, best, streak] of members) {
        await pool.query(
          `INSERT INTO party_members (party_id, user_id, username, score, best_round, streak, rounds_survived)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (party_id, user_id) DO NOTHING`,
          [partyId, uid, username, score, best, streak, streak]
        );
      }
      const now = new Date();
      const pr = await pool.query(
        `INSERT INTO party_rounds (party_id, round_number, status, target_room, hiding_ends_at, hunt_ends_at, resolved_at)
         VALUES ($1, 1, 'resolved', 'gudang', $2, $3, $4) ON CONFLICT (party_id, round_number) DO NOTHING RETURNING id`,
        [partyId, new Date(now.getTime() - 120000), new Date(now.getTime() - 114000), new Date(now.getTime() - 114000)]
      );
      if (pr.rows.length) {
        const hides = [
          [900001, 'staging-demo-user', 'library', 'survived', 420],
          [900002, 'staging-user-01', 'kamar-utama', 'survived', 380],
          [900003, 'staging-user-02', 'backyard', 'survived', 340],
          [900004, 'staging-user-03', 'gudang', 'eliminated', 0],
        ];
        for (const [uid, username, room, outcome, pts] of hides) {
          await pool.query(
            `INSERT INTO party_hides (party_round_id, user_id, username, room_slug, outcome, points_awarded)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (party_round_id, user_id) DO NOTHING`,
            [pr.rows[0].id, uid, username, room, outcome, pts]
          );
        }
      }
    }
  }
}

let shuttingDown = false;

async function start() {
  await migrate();
  // Self-heal at boot too, so a deploy onto an old or empty rounds table
  // opens a hiding round before the first poll arrives.
  try { await runTransitions(new Date()); } catch (e) { console.error('[start] runTransitions failed', e.message); }
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
