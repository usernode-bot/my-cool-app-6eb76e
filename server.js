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
const ENTRY_STAKE = 100;
const STARTING_BALANCE = 1000;
const MIN_BALANCE_FLOOR = 200;
const LOBBY_DURATION = 20000; // 20s in ms
const HIDING_DURATION = 12000; // 12s
const REVEAL_DURATION = 4000; // 4s
const RESULTS_DURATION = 8000; // 8s
const TARGET_LOBBY_SIZE = 50;
const MAX_SUBROUNDS = 8;
const SURVIVAL_THRESHOLD = 3; // Stop when <= 3 alive
const LOCK_ID = 1001; // Advisory lock ID for ticker

const ROOMS = [
  'Master Bedroom',
  'Library',
  'Kitchen',
  'Laundry Room',
  'Kids Bedroom',
  'Playing Room',
  'Living Room',
  'Bathroom',
  'Powder Room',
  'Backyard',
  'Warehouse',
  'Reading Room'
];

const BOT_NAMES = [
  'Bobo', 'Pepo', 'Toto', 'Wawa', 'Zaza', 'Kiki', 'Lala', 'Momo', 'Nana', 'Popo',
  'Roro', 'Soso', 'Tutu', 'Vovo', 'Xyxy', 'Yoyo', 'Zuzu', 'Aba', 'Bebe', 'Cece',
  'Dede', 'Fefe', 'Gaga', 'Haha', 'Jaja', 'Kaka', 'Lele', 'Meme', 'Nene', 'Pepe',
  'Rara', 'Sasa', 'Tata', 'Vava', 'Wawe', 'Zeze', 'Alby', 'Bilbo', 'Capri', 'Dingo',
  'Elmer', 'Felix', 'Gizmo', 'Hector', 'Irene', 'Joey', 'Kester', 'Larry', 'Marty', 'Ned',
  'Oscar', 'Patty', 'Quincy', 'Remy', 'Sammy', 'Tilly', 'Uriel', 'Vicky', 'Wally', 'Ziggy'
];

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

// Get current round or create new one
async function getCurrentRound() {
  const { rows } = await pool.query(
    `SELECT * FROM rounds WHERE status IN ('lobby', 'playing', 'results') ORDER BY id DESC LIMIT 1`
  );

  if (rows.length === 0) {
    return await createNewRound();
  }

  return rows[0];
}

// Create a new round in lobby phase
async function createNewRound() {
  const { rows } = await pool.query(
    `INSERT INTO rounds (status, phase, phase_ends_at, pot, entry_stake, subround, started_at)
     VALUES ('lobby', 'lobby', NOW() + INTERVAL '20 seconds', 0, $1, 1, NOW())
     RETURNING *`,
    [ENTRY_STAKE]
  );
  return rows[0];
}

// Run the game ticker (phase transitions)
async function tick() {
  const lockResult = await pool.query(`SELECT pg_try_advisory_lock($1) as locked`, [LOCK_ID]);

  if (!lockResult.rows[0].locked) {
    return; // Lock not acquired, skip this tick
  }

  try {
    const round = await getCurrentRound();
    const now = new Date();

    if (new Date(round.phase_ends_at) > now) {
      return; // Phase not over yet
    }

    // Transition to next phase
    if (round.phase === 'lobby') {
      await transitionToHiding(round);
    } else if (round.phase === 'hiding') {
      await transitionToReveal(round);
    } else if (round.phase === 'reveal') {
      const shouldEnd = await shouldEndRound(round);
      if (shouldEnd) {
        await transitionToResults(round);
      } else {
        await transitionToHiding(round);
      }
    } else if (round.phase === 'results') {
      await transitionToNewRound();
    }
  } finally {
    await pool.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID]);
  }
}

// Lobby -> Hiding: backfill bots
async function transitionToHiding(round) {
  // Count current participants
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) as count FROM round_participants WHERE round_id = $1`,
    [round.id]
  );

  const currentCount = parseInt(countRows[0].count);
  const botsNeeded = TARGET_LOBBY_SIZE - currentCount;

  // Add bots
  if (botsNeeded > 0) {
    for (let i = 0; i < botsNeeded; i++) {
      const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + '_' + i;
      await pool.query(
        `INSERT INTO round_participants (round_id, username, is_bot, stake, alive)
         VALUES ($1, $2, true, $3, true)`,
        [round.id, name, ENTRY_STAKE]
      );
    }
  }

  // Auto-assign bots to random rooms
  await pool.query(
    `UPDATE round_participants
     SET current_room = $2
     WHERE round_id = $1 AND is_bot = true AND current_room IS NULL`,
    [round.id, ROOMS[Math.floor(Math.random() * ROOMS.length)]]
  );

  // Update round to hiding phase
  await pool.query(
    `UPDATE rounds
     SET phase = 'hiding', phase_ends_at = NOW() + INTERVAL '12 seconds', subround = 1
     WHERE id = $1`,
    [round.id]
  );
}

// Hiding -> Reveal: choose pocong room, eliminate players
async function transitionToReveal(round) {
  const pocongRoom = ROOMS[Math.floor(Math.random() * ROOMS.length)];

  // Auto-assign players who didn't pick a room
  await pool.query(
    `UPDATE round_participants
     SET current_room = $2
     WHERE round_id = $1 AND current_room IS NULL`,
    [round.id, ROOMS[Math.floor(Math.random() * ROOMS.length)]]
  );

  // Eliminate players in the pocong room
  const { rows: eliminatedRows } = await pool.query(
    `UPDATE round_participants
     SET alive = false, eliminated_subround = $2
     WHERE round_id = $1 AND current_room = $3 AND alive = true
     RETURNING id`,
    [round.id, round.subround, pocongRoom]
  );

  const eliminatedCount = eliminatedRows.length;

  // Record the reveal
  await pool.query(
    `INSERT INTO round_reveals (round_id, subround, pocong_room, eliminated_count, revealed_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [round.id, round.subround, pocongRoom, eliminatedCount]
  );

  // Update round
  await pool.query(
    `UPDATE rounds
     SET phase = 'reveal', phase_ends_at = NOW() + INTERVAL '4 seconds'
     WHERE id = $1`,
    [round.id]
  );
}

// Check if round should end (survivors <= 3 or max subrounds reached)
async function shouldEndRound(round) {
  const { rows: aliveRows } = await pool.query(
    `SELECT COUNT(*) as count FROM round_participants WHERE round_id = $1 AND alive = true`,
    [round.id]
  );

  const aliveCount = parseInt(aliveRows[0].count);

  if (aliveCount === 0) {
    // Edge case: all killed, treat all as survivors
    await pool.query(
      `UPDATE round_participants SET alive = true WHERE round_id = $1 AND eliminated_subround = $2`,
      [round.id, round.subround]
    );
    return true;
  }

  return aliveCount <= SURVIVAL_THRESHOLD || round.subround >= MAX_SUBROUNDS;
}

// Reveal -> Hiding: next subround
async function transitionToHiding(round) {
  const nextSubround = round.subround + 1;

  // Clear current_room for next subround
  await pool.query(
    `UPDATE round_participants
     SET current_room = NULL
     WHERE round_id = $1 AND alive = true`,
    [round.id]
  );

  // Update round
  await pool.query(
    `UPDATE rounds
     SET phase = 'hiding', phase_ends_at = NOW() + INTERVAL '12 seconds', subround = $2
     WHERE id = $1`,
    [round.id, nextSubround]
  );
}

// Results: pay out survivors
async function transitionToResults(round) {
  const { rows: participants } = await pool.query(
    `SELECT * FROM round_participants WHERE round_id = $1 AND alive = true`,
    [round.id]
  );

  const realSurvivors = participants.filter(p => !p.is_bot);
  const botSurvivors = participants.filter(p => p.is_bot);

  if (realSurvivors.length > 0) {
    const payoutPerSurvivor = Math.floor(round.pot / realSurvivors.length);
    const remainder = round.pot % realSurvivors.length;

    for (let i = 0; i < realSurvivors.length; i++) {
      const payout = payoutPerSurvivor + (i === 0 ? remainder : 0);
      const placement = i + 1;

      await pool.query(
        `UPDATE round_participants
         SET payout = $2, placement = $3
         WHERE id = $1`,
        [realSurvivors[i].id, payout, placement]
      );

      // Update token account
      if (realSurvivors[i].user_id) {
        await pool.query(
          `UPDATE token_accounts
           SET balance = balance + $2, wins = wins + 1
           WHERE user_id = $1`,
          [realSurvivors[i].user_id, payout]
        );
      }
    }
  }

  // Update round status
  await pool.query(
    `UPDATE rounds
     SET status = 'results', phase = 'results', phase_ends_at = NOW() + INTERVAL '8 seconds'
     WHERE id = $1`,
    [round.id]
  );
}

// Results -> New Lobby
async function transitionToNewRound() {
  await pool.query(`UPDATE rounds SET status = 'closed' WHERE status = 'results'`);
  await createNewRound();
}

// API: Get round state
app.get('/api/round/state', async (req, res) => {
  try {
    await tick(); // Lazy advance

    const round = await getCurrentRound();
    const now = new Date();
    const phaseEndsAt = new Date(round.phase_ends_at);
    const secondsRemaining = Math.max(0, Math.ceil((phaseEndsAt - now) / 1000));

    // Get caller's participant record
    let participant = null;
    if (req.user) {
      const { rows } = await pool.query(
        `SELECT * FROM round_participants WHERE round_id = $1 AND user_id = $2`,
        [round.id, req.user.id]
      );
      participant = rows[0] || null;
    }

    // Get room occupancy for hiding phase
    let roomOccupancy = {};
    if (round.phase === 'hiding' || round.phase === 'reveal') {
      const { rows } = await pool.query(
        `SELECT current_room, COUNT(*) as count FROM round_participants
         WHERE round_id = $1 AND alive = true GROUP BY current_room`,
        [round.id]
      );
      rows.forEach(row => {
        roomOccupancy[row.current_room] = row.count;
      });
    }

    // Get latest reveal
    let latestReveal = null;
    if (round.phase === 'reveal') {
      const { rows } = await pool.query(
        `SELECT * FROM round_reveals WHERE round_id = $1 ORDER BY subround DESC LIMIT 1`,
        [round.id]
      );
      latestReveal = rows[0] || null;
    }

    // Get caller's balance
    let balance = 0;
    if (req.user) {
      const { rows } = await pool.query(
        `SELECT balance FROM token_accounts WHERE user_id = $1`,
        [req.user.id]
      );
      balance = rows[0]?.balance || STARTING_BALANCE;
    }

    // Count alive players
    const { rows: aliveRows } = await pool.query(
      `SELECT COUNT(*) as count FROM round_participants WHERE round_id = $1 AND alive = true`,
      [round.id]
    );
    const aliveCount = parseInt(aliveRows[0].count);

    res.json({
      round: {
        id: round.id,
        phase: round.phase,
        subround: round.subround,
        pot: round.pot,
        entry_stake: round.entry_stake,
        secondsRemaining,
        aliveCount
      },
      participant,
      roomOccupancy,
      latestReveal,
      balance
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: Join round
app.post('/api/round/join', async (req, res) => {
  try {
    const round = await getCurrentRound();

    if (round.phase !== 'lobby') {
      return res.status(400).json({ error: 'Not in lobby phase' });
    }

    // Ensure token account exists
    let account = await pool.query(
      `SELECT * FROM token_accounts WHERE user_id = $1`,
      [req.user.id]
    );

    if (account.rows.length === 0) {
      await pool.query(
        `INSERT INTO token_accounts (user_id, username, balance, wins, rounds_played)
         VALUES ($1, $2, $3, 0, 0)`,
        [req.user.id, req.user.username, STARTING_BALANCE]
      );
      account = await pool.query(
        `SELECT * FROM token_accounts WHERE user_id = $1`,
        [req.user.id]
      );
    }

    const balance = account.rows[0].balance;

    // Top up if needed
    let finalBalance = balance;
    if (balance < ENTRY_STAKE) {
      finalBalance = MIN_BALANCE_FLOOR;
      await pool.query(
        `UPDATE token_accounts SET balance = $2 WHERE user_id = $1`,
        [req.user.id, finalBalance]
      );
    }

    // Check if already joined
    const existing = await pool.query(
      `SELECT * FROM round_participants WHERE round_id = $1 AND user_id = $2`,
      [round.id, req.user.id]
    );

    if (existing.rows.length === 0) {
      // Add participant
      await pool.query(
        `INSERT INTO round_participants (round_id, user_id, username, stake, alive)
         VALUES ($1, $2, $3, $4, true)`,
        [round.id, req.user.id, req.user.username, ENTRY_STAKE]
      );

      // Update token account balance and pot
      await pool.query(
        `UPDATE token_accounts SET balance = balance - $2, rounds_played = rounds_played + 1
         WHERE user_id = $1`,
        [req.user.id, ENTRY_STAKE]
      );

      await pool.query(
        `UPDATE rounds SET pot = pot + $2 WHERE id = $1`,
        [round.id, ENTRY_STAKE]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: Hide in a room
app.post('/api/round/hide', async (req, res) => {
  try {
    const { room } = req.body;

    if (!ROOMS.includes(room)) {
      return res.status(400).json({ error: 'Invalid room' });
    }

    const round = await getCurrentRound();

    if (round.phase !== 'hiding') {
      return res.status(400).json({ error: 'Not in hiding phase' });
    }

    // Update participant's room
    const { rows } = await pool.query(
      `UPDATE round_participants
       SET current_room = $3
       WHERE round_id = $1 AND user_id = $2 AND alive = true
       RETURNING *`,
      [round.id, req.user.id, room]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Not a participant or already eliminated' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: Leaderboard
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
    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_accounts (
        user_id INTEGER PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        balance INTEGER DEFAULT 1000,
        wins INTEGER DEFAULT 0,
        rounds_played INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        id SERIAL PRIMARY KEY,
        status VARCHAR(20) DEFAULT 'lobby',
        phase VARCHAR(20) DEFAULT 'lobby',
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
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(round_id, user_id) WHERE user_id IS NOT NULL
      )
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
    if (parseInt(botCount[0].count) === 0) {
      for (let i = 0; i < BOT_NAMES.length; i++) {
        await pool.query(
          `INSERT INTO bot_characters (name, palette_index, hat_style)
           VALUES ($1, $2, $3)`,
          [BOT_NAMES[i], i % 5, ['none', 'hat', 'cap', 'bow'][i % 4]]
        );
      }
    }

    // Staging seed data
    if (IS_STAGING) {
      // Seed demo accounts
      for (let i = 1; i <= 5; i++) {
        await pool.query(
          `INSERT INTO token_accounts (user_id, username, balance, wins)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO NOTHING`,
          [9000 + i, `staging-demo-survivor-${i}`, 500 + i * 100, i * 2]
        );
      }

      // Seed a completed round
      const { rows: roundRows } = await pool.query(
        `INSERT INTO rounds (status, phase, phase_ends_at, pot, entry_stake, subround, started_at, ended_at)
         VALUES ('closed', 'results', NOW(), 500, 100, 5, NOW() - INTERVAL '5 minutes', NOW())
         ON CONFLICT DO NOTHING
         RETURNING id`
      );

      if (roundRows.length > 0) {
        const roundId = roundRows[0].id;
        for (let i = 1; i <= 5; i++) {
          await pool.query(
            `INSERT INTO round_participants (round_id, user_id, username, is_bot, stake, alive, placement, payout)
             VALUES ($1, $2, $3, false, 100, true, $4, $5)
             ON CONFLICT DO NOTHING`,
            [roundId, 9000 + i, `staging-demo-survivor-${i}`, i, 100 - (i-1)*10]
          );
        }

        await pool.query(
          `INSERT INTO round_reveals (round_id, subround, pocong_room, eliminated_count, revealed_at)
           VALUES ($1, 1, $2, 2, NOW())
           ON CONFLICT DO NOTHING`,
          [roundId, 'Kitchen']
        );
      }
    }

    // Ensure there's always a current round
    const { rows } = await pool.query(
      `SELECT COUNT(*) as count FROM rounds WHERE status IN ('lobby', 'playing', 'results')`
    );
    if (parseInt(rows[0].count) === 0) {
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
