const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const PUBLIC_API_PATHS = new Set(['/health']);

// Game constants
const STARTING_BALANCE = 0;         // new accounts start with 0 TKN, must deposit
const MIN_BALANCE_FLOOR = 200;
const SMALLEST_CHIP = 100;          // below this, faucet tops up
const DEFAULT_STANDARD_BET = 100;
const BET_CAP = 100000;             // max single bet amount
const PAYOUT_MULTIPLIER = 3;        // safe-room bets pay 3x
const MAX_REAL_PLAYERS = 100;       // real participants per round
const TARGET_BOARD_SIZE = 50;       // bots backfill the board to here
const WITHDRAWAL_FEE = 10;          // 10 TKN fee per withdrawal
const ON_CHAIN_ADDRESS = 'ut1xqgzkzd8tesvwg3f4pm7ghspqpd3edwgydkcpvlha3em0frm78es6uft0u';

const BETTING_DURATION = 20000;     // 20s
const REVEAL_DURATION = 6000;       // 6s (covers ~2.5s corridor hop + settle)
const RESULTS_DURATION = 8000;      // 8s
const LOCK_ID = 1001;               // Advisory lock ID for ticker

const ROOMS = [
  'Master Bedroom',
  'Library',
  'Kitchen',
  'Dining Room',
  'Laundry Room',
  'Kids Bedroom',
  'Playing Room',
  'Living Room',
  'Bathroom',
  'Powder Room',
  'Backyard',
  'Warehouse',
  'Reading Room',
  'Theater Room'
];

const BOT_NAMES = [
  'Bobo', 'Pepo', 'Toto', 'Wawa', 'Zaza', 'Kiki', 'Lala', 'Momo', 'Nana', 'Popo',
  'Roro', 'Soso', 'Tutu', 'Vovo', 'Xyxy', 'Yoyo', 'Zuzu', 'Aba', 'Bebe', 'Cece',
  'Dede', 'Fefe', 'Gaga', 'Haha', 'Jaja', 'Kaka', 'Lele', 'Meme', 'Nene', 'Pepe',
  'Rara', 'Sasa', 'Tata', 'Vava', 'Wawe', 'Zeze', 'Alby', 'Bilbo', 'Capri', 'Dingo',
  'Elmer', 'Felix', 'Gizmo', 'Hector', 'Irene', 'Joey', 'Kester', 'Larry', 'Marty', 'Ned',
  'Oscar', 'Patty', 'Quincy', 'Remy', 'Sammy', 'Tilly', 'Uriel', 'Vicky', 'Wally', 'Ziggy'
];

const BOT_CHIPS = [100, 100, 200, 200, 500];

app.use(express.json());

// Auth middleware
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

function randomRoom() {
  return ROOMS[Math.floor(Math.random() * ROOMS.length)];
}

// Get current active round, creating one if none exists
async function getCurrentRound() {
  const { rows } = await pool.query(
    `SELECT * FROM rounds WHERE status = 'active' ORDER BY id DESC LIMIT 1`
  );
  if (rows.length === 0) {
    return await createNewRound();
  }
  return rows[0];
}

// Create a new round in the betting phase
async function createNewRound() {
  const { rows } = await pool.query(
    `INSERT INTO rounds (status, phase, phase_ends_at, pot, entry_stake, subround, started_at)
     VALUES ('active', 'betting', NOW() + INTERVAL '20 seconds', 0, $1, 1, NOW())
     RETURNING *`,
    [DEFAULT_STANDARD_BET]
  );
  return rows[0];
}

// Idempotently place bot participants + demo bets so the board looks alive
async function ensureBots(round) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS c FROM round_participants WHERE round_id = $1 AND is_bot = true`,
    [round.id]
  );
  if (parseInt(rows[0].c, 10) > 0) return; // already seeded for this round

  const { rows: realRows } = await pool.query(
    `SELECT COUNT(*) AS c FROM round_participants WHERE round_id = $1 AND user_id IS NOT NULL`,
    [round.id]
  );
  const realCount = parseInt(realRows[0].c, 10);
  const botsNeeded = Math.max(0, TARGET_BOARD_SIZE - realCount);

  let potDelta = 0;
  for (let i = 0; i < botsNeeded; i++) {
    const name = BOT_NAMES[i % BOT_NAMES.length] + '_' + i;
    const { rows: pr } = await pool.query(
      `INSERT INTO round_participants (round_id, username, is_bot, alive)
       VALUES ($1, $2, true, true) RETURNING id`,
      [round.id, name]
    );
    const participantId = pr[0].id;

    const numBets = 1 + Math.floor(Math.random() * 3); // 1-3 rooms
    for (let b = 0; b < numBets; b++) {
      const room = randomRoom();
      const amount = BOT_CHIPS[Math.floor(Math.random() * BOT_CHIPS.length)];
      await pool.query(
        `INSERT INTO room_bets (round_id, participant_id, user_id, is_bot, room, amount)
         VALUES ($1, $2, NULL, true, $3, $4)
         ON CONFLICT (round_id, participant_id, room)
         DO UPDATE SET amount = room_bets.amount + EXCLUDED.amount`,
        [round.id, participantId, room, amount]
      );
      potDelta += amount;
    }
  }

  if (potDelta > 0) {
    await pool.query(`UPDATE rounds SET pot = pot + $2 WHERE id = $1`, [round.id, potDelta]);
  }
}

// Betting -> Reveal: choose haunted room, resolve all bets, credit real winners
async function transitionToReveal(round) {
  const hauntedRoom = randomRoom();

  // Count distinct participants who bet on the haunted room
  const { rows: hauntRows } = await pool.query(
    `SELECT COUNT(DISTINCT participant_id) AS c FROM room_bets WHERE round_id = $1 AND room = $2`,
    [round.id, hauntedRoom]
  );
  const hauntedCount = parseInt(hauntRows[0].c, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve every bet: safe rooms pay 2x, haunted room pays 0
    await client.query(
      `UPDATE room_bets
       SET payout = CASE WHEN room = $2 THEN 0 ELSE amount * $3 END,
           resolved = true
       WHERE round_id = $1`,
      [round.id, hauntedRoom, PAYOUT_MULTIPLIER]
    );

    // Aggregate totals onto each participant
    await client.query(
      `UPDATE round_participants p
       SET total_staked = COALESCE(agg.staked, 0),
           payout = COALESCE(agg.pay, 0),
           net = COALESCE(agg.pay, 0) - COALESCE(agg.staked, 0)
       FROM (
         SELECT participant_id, SUM(amount) AS staked, SUM(payout) AS pay
         FROM room_bets WHERE round_id = $1 GROUP BY participant_id
       ) agg
       WHERE p.id = agg.participant_id`,
      [round.id]
    );

    // Rank placement by net result (desc)
    await client.query(
      `UPDATE round_participants p
       SET placement = ranked.rnk
       FROM (
         SELECT id, RANK() OVER (ORDER BY net DESC) AS rnk
         FROM round_participants WHERE round_id = $1
       ) ranked
       WHERE p.id = ranked.id`,
      [round.id]
    );

    // Credit REAL participants only; bot winnings are discarded
    await client.query(
      `UPDATE token_accounts t
       SET balance = t.balance + p.payout,
           wins = t.wins + CASE WHEN p.net > 0 THEN 1 ELSE 0 END,
           rounds_played = t.rounds_played + 1
       FROM round_participants p
       WHERE p.round_id = $1 AND p.user_id IS NOT NULL AND p.user_id = t.user_id`,
      [round.id]
    );

    // Record the reveal
    await client.query(
      `INSERT INTO round_reveals (round_id, subround, pocong_room, eliminated_count, revealed_at)
       VALUES ($1, 1, $2, $3, NOW())`,
      [round.id, hauntedRoom, hauntedCount]
    );

    // Move to reveal phase
    await client.query(
      `UPDATE rounds SET phase = 'reveal', phase_ends_at = NOW() + INTERVAL '6 seconds' WHERE id = $1`,
      [round.id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Reveal -> Results
async function transitionToResults(round) {
  await pool.query(
    `UPDATE rounds SET status = 'active', phase = 'results', phase_ends_at = NOW() + INTERVAL '8 seconds' WHERE id = $1`,
    [round.id]
  );
}

// Results -> New round
async function transitionToNewRound(round) {
  await pool.query(`UPDATE rounds SET status = 'closed', ended_at = NOW() WHERE id = $1`, [round.id]);
  await createNewRound();
}

// Game ticker (phase transitions), guarded by an advisory lock
async function tick() {
  const lockResult = await pool.query(`SELECT pg_try_advisory_lock($1) as locked`, [LOCK_ID]);
  if (!lockResult.rows[0].locked) return;

  try {
    const round = await getCurrentRound();

    // Keep the board alive during betting (idempotent)
    if (round.phase === 'betting') {
      await ensureBots(round);
    }

    if (new Date(round.phase_ends_at) > new Date()) {
      return; // phase not over yet
    }

    if (round.phase === 'betting') {
      await transitionToReveal(round);
    } else if (round.phase === 'reveal') {
      await transitionToResults(round);
    } else if (round.phase === 'results') {
      await transitionToNewRound(round);
    }
  } finally {
    await pool.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID]);
  }
}

// Ensure a token account exists (with faucet floor); returns the account row
async function ensureAccount(userId, username) {
  let { rows } = await pool.query(`SELECT * FROM token_accounts WHERE user_id = $1`, [userId]);
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO token_accounts (user_id, username, balance, wins, rounds_played)
       VALUES ($1, $2, $3, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId, username || ('player_' + userId), STARTING_BALANCE]
    );
    ({ rows } = await pool.query(`SELECT * FROM token_accounts WHERE user_id = $1`, [userId]));
  }

  // Anti-stuck faucet: never let a real player be locked out
  if (rows[0].balance < SMALLEST_CHIP) {
    await pool.query(`UPDATE token_accounts SET balance = $2 WHERE user_id = $1`, [userId, MIN_BALANCE_FLOOR]);
    rows[0].balance = MIN_BALANCE_FLOOR;
  }
  return rows[0];
}

// Find or create the caller's participant row for a round; enforces 100-player cap
async function ensureParticipant(round, userId, username) {
  const { rows } = await pool.query(
    `SELECT * FROM round_participants WHERE round_id = $1 AND user_id = $2`,
    [round.id, userId]
  );
  if (rows.length > 0) return { participant: rows[0], created: false };

  const { rows: cntRows } = await pool.query(
    `SELECT COUNT(*) AS c FROM round_participants WHERE round_id = $1 AND user_id IS NOT NULL`,
    [round.id]
  );
  if (parseInt(cntRows[0].c, 10) >= MAX_REAL_PLAYERS) {
    return { participant: null, created: false, full: true };
  }

  const { rows: ins } = await pool.query(
    `INSERT INTO round_participants (round_id, user_id, username, is_bot, alive)
     VALUES ($1, $2, $3, false, true)
     ON CONFLICT (round_id, user_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING *`,
    [round.id, userId, username || ('player_' + userId)]
  );
  return { participant: ins[0], created: true };
}

// API: round state (single poll endpoint)
app.get('/api/round/state', async (req, res) => {
  try {
    await tick(); // lazy advance

    const round = await getCurrentRound();
    const now = new Date();
    const phaseEndsAt = new Date(round.phase_ends_at);
    const secondsRemaining = Math.max(0, Math.ceil((phaseEndsAt - now) / 1000));

    // Caller's participant + balance
    let participant = null;
    let balance = STARTING_BALANCE;
    if (req.user) {
      const { rows: pRows } = await pool.query(
        `SELECT * FROM round_participants WHERE round_id = $1 AND user_id = $2`,
        [round.id, req.user.id]
      );
      participant = pRows[0] || null;

      const { rows: aRows } = await pool.query(
        `SELECT balance FROM token_accounts WHERE user_id = $1`, [req.user.id]
      );
      if (aRows.length) balance = aRows[0].balance;
    }

    // Caller's per-room bets
    const bets = {};
    if (req.user) {
      const { rows: bRows } = await pool.query(
        `SELECT room, amount FROM room_bets WHERE round_id = $1 AND user_id = $2`,
        [round.id, req.user.id]
      );
      bRows.forEach(r => { bets[r.room] = r.amount; });
    }

    // Aggregate per-room stake totals (all participants)
    const roomTotals = {};
    const { rows: rtRows } = await pool.query(
      `SELECT room, SUM(amount) AS total FROM room_bets WHERE round_id = $1 GROUP BY room`,
      [round.id]
    );
    rtRows.forEach(r => { roomTotals[r.room] = parseInt(r.total, 10); });

    // Haunted room during reveal/results
    let hauntedRoom = null;
    if (round.phase === 'reveal' || round.phase === 'results') {
      const { rows: revRows } = await pool.query(
        `SELECT pocong_room FROM round_reveals WHERE round_id = $1 ORDER BY id DESC LIMIT 1`,
        [round.id]
      );
      if (revRows.length) hauntedRoom = revRows[0].pocong_room;
    }

    res.json({
      round: {
        id: round.id,
        phase: round.phase,
        secondsRemaining,
        pot: round.pot,
        entry_stake: round.entry_stake
      },
      participant,
      bets,
      roomTotals,
      balance,
      hauntedRoom
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: place a bet on a room
app.post('/api/round/bet', async (req, res) => {
  try {
    const { room } = req.body;
    let amount = parseInt(req.body.amount, 10);

    if (!ROOMS.includes(room)) {
      return res.status(400).json({ error: 'Invalid room' });
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > BET_CAP) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const round = await getCurrentRound();
    if (round.phase !== 'betting') {
      return res.status(400).json({ error: 'Betting is closed' });
    }

    const account = await ensureAccount(req.user.id, req.user.username);
    if (amount > account.balance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const { participant, full } = await ensureParticipant(round, req.user.id, req.user.username);
    if (full) {
      return res.status(403).json({ error: 'Round is full (100 players)' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Debit balance (guarded so it can't go negative under races)
      const { rows: debit } = await client.query(
        `UPDATE token_accounts SET balance = balance - $2
         WHERE user_id = $1 AND balance >= $2 RETURNING balance`,
        [req.user.id, amount]
      );
      if (debit.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      // Upsert-increment the room bet
      await client.query(
        `INSERT INTO room_bets (round_id, participant_id, user_id, is_bot, room, amount)
         VALUES ($1, $2, $3, false, $4, $5)
         ON CONFLICT (round_id, participant_id, room)
         DO UPDATE SET amount = room_bets.amount + EXCLUDED.amount`,
        [round.id, participant.id, req.user.id, room, amount]
      );

      await client.query(`UPDATE rounds SET pot = pot + $2 WHERE id = $1`, [round.id, amount]);

      await client.query('COMMIT');
      res.json({ ok: true, balance: debit[0].balance });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: clear/refund bets (one room, or all if no room given)
app.post('/api/round/clear', async (req, res) => {
  try {
    const room = req.body ? req.body.room : undefined;

    const round = await getCurrentRound();
    if (round.phase !== 'betting') {
      return res.status(400).json({ error: 'Betting is closed' });
    }

    const { rows: pRows } = await pool.query(
      `SELECT * FROM round_participants WHERE round_id = $1 AND user_id = $2`,
      [round.id, req.user.id]
    );
    if (pRows.length === 0) return res.json({ ok: true, balance: null });
    const participantId = pRows[0].id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let refund;
      if (room) {
        if (!ROOMS.includes(room)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Invalid room' });
        }
        const { rows } = await client.query(
          `DELETE FROM room_bets WHERE round_id = $1 AND participant_id = $2 AND room = $3
           RETURNING amount`,
          [round.id, participantId, room]
        );
        refund = rows.reduce((s, r) => s + r.amount, 0);
      } else {
        const { rows } = await client.query(
          `DELETE FROM room_bets WHERE round_id = $1 AND participant_id = $2 RETURNING amount`,
          [round.id, participantId]
        );
        refund = rows.reduce((s, r) => s + r.amount, 0);
      }

      let balance = null;
      if (refund > 0) {
        const { rows: bal } = await client.query(
          `UPDATE token_accounts SET balance = balance + $2 WHERE user_id = $1 RETURNING balance`,
          [req.user.id, refund]
        );
        balance = bal.length ? bal[0].balance : null;
        await client.query(`UPDATE rounds SET pot = GREATEST(0, pot - $2) WHERE id = $1`, [round.id, refund]);
      }

      await client.query('COMMIT');
      res.json({ ok: true, refunded: refund, balance });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: ensure account (optional; betting auto-joins). Kept to avoid client churn.
app.post('/api/round/join', async (req, res) => {
  try {
    const account = await ensureAccount(req.user.id, req.user.username);
    res.json({ ok: true, balance: account.balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: leaderboard (Hall of Survivors)
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT username, balance, wins FROM token_accounts
       WHERE user_id IS NOT NULL
       ORDER BY balance DESC, wins DESC LIMIT 50`
    );
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: wallet state
app.get('/api/wallet/state', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT balance, pending_tx, pending_tx_type, pending_tx_amount FROM token_accounts WHERE user_id = $1`,
      [req.user.id]
    );
    const account = rows.length ? rows[0] : { balance: STARTING_BALANCE, pending_tx: null, pending_tx_type: null, pending_tx_amount: null };
    res.json({
      balance: account.balance,
      address: ON_CHAIN_ADDRESS,
      pending_tx: account.pending_tx,
      pending_tx_type: account.pending_tx_type,
      pending_tx_amount: account.pending_tx_amount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: start a deposit (create pending tx)
app.post('/api/wallet/deposit-start', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isFinite(amount) || amount <= 0 || amount > BET_CAP) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const account = await ensureAccount(req.user.id, req.user.username);
    const txHash = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(7);

    await pool.query(
      `UPDATE token_accounts SET pending_tx = $2, pending_tx_type = 'deposit', pending_tx_amount = $3
       WHERE user_id = $1`,
      [req.user.id, txHash, amount]
    );

    res.json({ ok: true, txHash, address: ON_CHAIN_ADDRESS, amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: confirm a deposit (credit balance after tx confirms)
app.post('/api/wallet/deposit-confirm', async (req, res) => {
  try {
    const txHash = req.body.txHash;
    if (!txHash) {
      return res.status(400).json({ error: 'Missing txHash' });
    }

    const { rows: pending } = await pool.query(
      `SELECT balance, pending_tx, pending_tx_type, pending_tx_amount FROM token_accounts
       WHERE user_id = $1 AND pending_tx = $2 AND pending_tx_type = 'deposit'`,
      [req.user.id, txHash]
    );

    if (pending.length === 0) {
      return res.status(400).json({ error: 'No pending deposit for this tx' });
    }

    const amount = pending[0].pending_tx_amount;

    const { rows: updated } = await pool.query(
      `UPDATE token_accounts
       SET balance = balance + $2, pending_tx = NULL, pending_tx_type = NULL, pending_tx_amount = NULL
       WHERE user_id = $1
       RETURNING balance`,
      [req.user.id, amount]
    );

    res.json({ ok: true, balance: updated[0].balance, amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: start a withdrawal (debit balance, mark as pending)
app.post('/api/wallet/withdrawal-start', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT balance FROM token_accounts WHERE user_id = $1`,
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No account' });
    }

    const balance = rows[0].balance;
    if (balance < WITHDRAWAL_FEE) {
      return res.status(400).json({ error: 'Insufficient balance for withdrawal (need at least 10 TKN)' });
    }

    const withdrawAmount = balance - WITHDRAWAL_FEE;
    const txHash = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(7);

    const { rows: updated } = await pool.query(
      `UPDATE token_accounts
       SET balance = 0, pending_tx = $2, pending_tx_type = 'withdrawal', pending_tx_amount = $3
       WHERE user_id = $1
       RETURNING balance`,
      [req.user.id, txHash, withdrawAmount]
    );

    res.json({ ok: true, txHash, address: ON_CHAIN_ADDRESS, amount: withdrawAmount, fee: WITHDRAWAL_FEE });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: confirm a withdrawal (clear pending tx)
app.post('/api/wallet/withdrawal-confirm', async (req, res) => {
  try {
    const txHash = req.body.txHash;
    if (!txHash) {
      return res.status(400).json({ error: 'Missing txHash' });
    }

    const { rows: pending } = await pool.query(
      `SELECT pending_tx_type FROM token_accounts WHERE user_id = $1 AND pending_tx = $2`,
      [req.user.id, txHash]
    );

    if (pending.length === 0 || pending[0].pending_tx_type !== 'withdrawal') {
      return res.status(400).json({ error: 'No pending withdrawal for this tx' });
    }

    await pool.query(
      `UPDATE token_accounts
       SET pending_tx = NULL, pending_tx_type = NULL, pending_tx_amount = NULL
       WHERE user_id = $1`,
      [req.user.id]
    );

    res.json({ ok: true, message: 'Withdrawal confirmed' });
  } catch (err) {
    console.error(err);
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

async function start() {
  try {
    // ---- Schema (idempotent) ----
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_accounts (
        user_id INTEGER PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        balance INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        rounds_played INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`ALTER TABLE token_accounts ADD COLUMN IF NOT EXISTS pending_tx VARCHAR(255)`);
    await pool.query(`ALTER TABLE token_accounts ADD COLUMN IF NOT EXISTS pending_tx_type VARCHAR(20)`);
    await pool.query(`ALTER TABLE token_accounts ADD COLUMN IF NOT EXISTS pending_tx_amount INTEGER`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        id SERIAL PRIMARY KEY,
        status VARCHAR(20) DEFAULT 'active',
        phase VARCHAR(20) DEFAULT 'betting',
        phase_ends_at TIMESTAMPTZ NOT NULL,
        pot INTEGER DEFAULT 0,
        entry_stake INTEGER DEFAULT 100,
        subround INTEGER DEFAULT 1,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS round_participants (
        id SERIAL PRIMARY KEY,
        round_id INTEGER NOT NULL REFERENCES rounds(id),
        user_id INTEGER,
        username VARCHAR(255) NOT NULL,
        is_bot BOOLEAN DEFAULT false,
        stake INTEGER DEFAULT 0,
        current_room VARCHAR(255),
        alive BOOLEAN DEFAULT true,
        eliminated_subround INTEGER,
        placement INTEGER,
        payout INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`ALTER TABLE round_participants ADD COLUMN IF NOT EXISTS total_staked INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE round_participants ADD COLUMN IF NOT EXISTS net INTEGER DEFAULT 0`);

    // One participant row per real user per round (bots have NULL user_id, exempt)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS round_participants_round_user_uniq
      ON round_participants (round_id, user_id)
      WHERE user_id IS NOT NULL
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS room_bets (
        id SERIAL PRIMARY KEY,
        round_id INTEGER NOT NULL REFERENCES rounds(id),
        participant_id INTEGER NOT NULL REFERENCES round_participants(id),
        user_id INTEGER,
        is_bot BOOLEAN DEFAULT false,
        room VARCHAR(255) NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        payout INTEGER DEFAULT 0,
        resolved BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Upsert-increment target: one row per (round, participant, room)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS room_bets_round_participant_room_uniq
      ON room_bets (round_id, participant_id, room)
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS round_reveals (
        id SERIAL PRIMARY KEY,
        round_id INTEGER NOT NULL REFERENCES rounds(id),
        subround INTEGER NOT NULL,
        pocong_room VARCHAR(255) NOT NULL,
        eliminated_count INTEGER DEFAULT 0,
        revealed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_characters (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        palette_index INTEGER,
        hat_style VARCHAR(50)
      )
    `);

    // Seed bot_characters (idempotent)
    const { rows: botCount } = await pool.query(`SELECT COUNT(*) as count FROM bot_characters`);
    if (parseInt(botCount[0].count, 10) === 0) {
      for (let i = 0; i < BOT_NAMES.length; i++) {
        await pool.query(
          `INSERT INTO bot_characters (name, palette_index, hat_style)
           VALUES ($1, $2, $3)`,
          [BOT_NAMES[i], i % 5, ['none', 'hat', 'cap', 'bow'][i % 4]]
        );
      }
    }

    // ---- Staging seed data ----
    if (IS_STAGING) {
      // Demo accounts for the Hall of Survivors
      for (let i = 1; i <= 5; i++) {
        await pool.query(
          `INSERT INTO token_accounts (user_id, username, balance, wins)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO NOTHING`,
          [9000 + i, `staging-demo-survivor-${i}`, 500 + i * 220, i * 2]
        );
      }

      // A completed demo round with resolved room bets (idempotent via existence check)
      const { rows: existingDemo } = await pool.query(
        `SELECT round_id FROM round_participants
         WHERE user_id BETWEEN 9001 AND 9005 ORDER BY round_id LIMIT 1`
      );

      if (existingDemo.length === 0) {
        const hauntedRoom = 'Kitchen';
        const { rows: roundRows } = await pool.query(
          `INSERT INTO rounds (status, phase, phase_ends_at, pot, entry_stake, subround, started_at, ended_at)
           VALUES ('closed', 'results', NOW(), 1500, 100, 1, NOW() - INTERVAL '5 minutes', NOW())
           RETURNING id`
        );
        const roundId = roundRows[0].id;

        // Spread demo bets: some on the haunted room (lost), some safe (2x)
        const demoBets = [
          { room: 'Library', safe: true },
          { room: 'Kitchen', safe: false },
          { room: 'Backyard', safe: true },
          { room: 'Theater Room', safe: true },
          { room: 'Dining Room', safe: true }
        ];

        for (let i = 1; i <= 5; i++) {
          const bet = demoBets[i - 1];
          const amount = 100 * i;
          const payout = bet.safe ? amount * 2 : 0;
          const { rows: pr } = await pool.query(
            `INSERT INTO round_participants
               (round_id, user_id, username, is_bot, total_staked, payout, net, placement, alive)
             VALUES ($1, $2, $3, false, $4, $5, $6, $7, true)
             RETURNING id`,
            [roundId, 9000 + i, `staging-demo-survivor-${i}`, amount, payout, payout - amount, i]
          );
          await pool.query(
            `INSERT INTO room_bets (round_id, participant_id, user_id, is_bot, room, amount, payout, resolved)
             VALUES ($1, $2, $3, false, $4, $5, $6, true)`,
            [roundId, pr[0].id, 9000 + i, bet.room, amount, payout]
          );
        }

        await pool.query(
          `INSERT INTO round_reveals (round_id, subround, pocong_room, eliminated_count, revealed_at)
           VALUES ($1, 1, $2, 1, NOW())`,
          [roundId, hauntedRoom]
        );
      }
    }

    // Ensure there is always an active round
    const { rows } = await pool.query(
      `SELECT COUNT(*) as count FROM rounds WHERE status = 'active'`
    );
    if (parseInt(rows[0].count, 10) === 0) {
      await createNewRound();
    }

    // Start ticker
    setInterval(tick, 750);

    app.listen(port, () => console.log(`Listening on :${port}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
