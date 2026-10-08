# Awas Ada Pocong — Developer Guide

This app runs on **Usernode Social Vibecoding**. Platform-wide rules live at:
**https://social-vibecoding.usernodelabs.org/claude.md**

Fetch that URL at the start of each session. If a rule below conflicts with the hosted conventions, **the hosted conventions win**. This file covers app-specific details only.

---

## 1. Game concept

**Awas Ada Pocong** ("Watch Out, There's a Pocong") is a horror-comedy **single-player hide-and-seek** game. Each round the player has 60 seconds to hide in one of 11 rooms of a blueprint floorplan of Mansion Level 1, then the Pocong (a traditional Indonesian ghost — a corpse wrapped in white burial cloth that hops around) walks the hallway and enters exactly ONE random room. If it enters the player's room, the player is found (jump-scare, eliminated); otherwise the player survives and scores points.

- Genre: Indonesian horror-comedy.
- Visual tone: pale blueprint floorplan (paper background, black ink line work, red Pocong Route), Creepster horror font, dark red-bordered cards for the result/lounge.
- Scoring: points and streaks. Surviving earns points (rooms further along the Pocong's walk are worth more: 100–200); a survival streak multiplies the score (×1, ×1.25, … up to ×3); an optional "dare pick" (a second room to avoid) multiplies by ×1.5.
- **No wagering.** There are no coins, stakes, bets, odds or payouts anywhere — the app is scored in points only. Leaderboards and rankings are fine.

## 2. File structure

```
/
├── server.js                  # Express server — DB migrations, auth, hunt + scores API
├── package.json               # Dependencies: express, pg, jsonwebtoken
├── dapp.json                  # App manifest (name, no extra secrets, CI tests)
├── .gitignore                 # node_modules/
├── CLAUDE.md                  # This file
└── public/
    ├── index.html             # ENTIRE game — SVG blueprint map + all UI (single file)
    └── assets/
        ├── pocong.jpg         # Ghost sprite image (used in the SVG + jump-scare)
        ├── hatch.png          # Unused tiling texture (kept for compatibility)
        └── ui-reference.png   # Old design reference (unused)
```

There is **no build step** — everything is served statically by Express.

## 3. Stack & dependencies

| Layer | Tech |
|---|---|
| Server | Node.js / Express |
| Database | PostgreSQL via `pg` npm package |
| Auth | JWT (`jsonwebtoken`) — Usernode platform tokens (RS256, `USERNODE_JWT_PUBLIC_KEY`) |
| Map | Inline SVG (no Three.js) — isometric floorplan, viewBox `0 0 1376 768` |
| Audio | Web Audio API, fully synthesized (heartbeat, breathing, footsteps, jump-scare sting) |
| Font | Google Fonts — Creepster (horror decorative) |

## 4. Rooms (single source of truth)

`HUNT_ROOMS` in `server.js` is the server's list; `ROOMS` in `index.html` must list the same slugs in the same order (door/route order). The hallway is row `gz=1`, `gx 0..5`; north rooms `gz=0`, south rooms `gz=2`; the Entrance (`gx 0, gz 2`) is a non-selectable foyer; the Pocong spawns at hallway `gx 0`. Points: `100 + 10 × (door − 1)`.

| Door | slug | Label | gx, gz | Points | Hiding spot |
|---|---|---|---|---|---|
| 1 | `master-bedroom` | Master Bedroom | 0, 0 | 100 | under the bed |
| 2 | `kids-bedroom` | Kids' Bedroom | 1, 0 | 110 | inside the toy box |
| 3 | `living-room` | Living Room | 1, 2 | 120 | behind the sofa |
| 4 | `library` | Library | 2, 0 | 130 | behind a bookshelf |
| 5 | `kitchen` | Kitchen | 2, 2 | 140 | under the kitchen table |
| 6 | `reading-room` | Reading Room | 3, 0 | 150 | behind the armchair |
| 7 | `bathroom` | Bathroom | 3, 2 | 160 | behind the shower curtain |
| 8 | `assistants-room` | Assistant's Room | 4, 0 | 170 | under the desk |
| 9 | `secondary-bathroom` | Secondary Bathroom | 4, 2 | 180 | behind the laundry basket |
| 10 | `storage-room` | Storage Room | 5, 0 | 190 | between the crates |
| 11 | `backyard` | Backyard | 5, 2 | 200 | behind the bush |

## 7. UI layout

- `#title` — Creepster title, ink on paper during hiding, light in the dark phases.
- `#game-svg` — the blueprint map (layers: `static, footprints, avatar, ghost, labels, hotspots`). Each room floor diamond is a hotspot (`tabindex=0`, `role=button`).
- `#hide-panel` — side panel (right, 300px; bottom sheet under 768px): phase banner, `Hiding Phase: MM:SS` timer, chosen room, room points, `User Location: NOT LOCKED/LOCKED IN`, player, dare checkbox, `CONFIRM & PLACE`, `Streak ×N · Best N`, BPM readout during the hunt.
- `#mute-btn` — fixed top-left, z-index above every overlay; mutes/unmutes all game sound; persists in localStorage `pocong-muted`.
- `#jumpscare` — fixed overlay: pocong.jpg lunge, white flash, black fade.
- `#intro-overlay` — "How to play" card, shown once per device (localStorage `pocong-intro-v2`).
- `#result-overlay` — survived card ("You survived!", +points, streak, leaderboard, Next round) or lounge card ("FOUND!" / "DISQUALIFIED", leaderboard, Play again).

### Timer rule (hard requirement)

`endAt = Date.now() + 60000` on Start hiding / Next round / Play again. `tick()` computes `remaining = Math.max(0, endAt - Date.now())` — nothing ever decrements a counter. `tick()` runs from a 250ms interval, the rAF loop, and `visibilitychange`/`pageshow`/`focus`. Reaching 00:00 without locking in → disqualified.

### Audio rule (hard requirement)

The `AudioContext` is created only inside the first `pointerdown`/`keydown` handler. Loops (heartbeat, breathing, footsteps) start only in the hunt phase. The jump-scare sting runs through its own `scareGain` above the compressed `ambienceBus`, which is dropped to zero before the sting plays, so it is the loudest moment by construction. Muting never stops sources or suspends the context.

## 8. Server API

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | public | `{ status: 'ok' }` |
| GET | `/api/game/scores` | public | `{ leaders: [{username, best}] }` (top 10 by `MAX(points)` where `outcome='survived'`), plus `me: {username, best, streak}` when authenticated |
| POST | `/api/game/hunt` | required | Body `{ room, dare_room }` (nulls when not locked). Validates against `HUNT_ROOMS` (400 otherwise); 429 if the user's latest row is under 55s old; picks `target` at random from `HUNT_ROOMS`; scores survived/found/disqualified; appends to `game_scores`; returns `{ target, outcome, points, streak, multiplier, best }` |
| POST | `/api/press`, GET `/api/leaderboard` | required | Legacy press endpoints, unused by the game |

Public paths: `/health`, `/api/game/scores`. Everything else under `/api/` requires the `x-usernode-token` JWT (`?token=` on first load is stored by the client and replayed as a header).

## 9. Database schema

Migrations are idempotent (`CREATE TABLE IF NOT EXISTS` on every boot). Legacy `presses` and old betting tables (`rounds`, `bets`) are left in place but unused; do not drop them.

```sql
CREATE TABLE IF NOT EXISTS game_scores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  username VARCHAR(255) NOT NULL,
  room_slug VARCHAR(50),          -- null when disqualified
  dare_room VARCHAR(50),
  target_room VARCHAR(50),        -- null when disqualified
  outcome VARCHAR(20) NOT NULL,   -- 'survived' | 'found' | 'disqualified'
  points INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS game_scores_user_idx ON game_scores (user_id, created_at DESC);
```

Append-only. `outcome` means: `'found'` = the Pocong entered the player's room (bad); `'survived'` = the player's rooms were missed. Staging seed inserts 5 leaderboard rows for `Staging demo Rina/Budi/Sari/Joko/Dewi` (user ids 900001–900005) when none exist.

## 15. App-specific conventions

- No wagering words anywhere in the UI: never "bet", "TKN", "coin", "odds", "payout", "stake".
- Room slugs are the shared contract between `HUNT_ROOMS` (server) and `ROOMS` (client) — keep both in sync, in door order.
- Scoring lives on the server (`roomPoints(slug) = 100 + 10 × HUNT_ROOMS.indexOf(slug)`); the client copies the formula only for display and its offline fallback (`localStorage pocong-local`).
- The mute setting is remembered on the device; no sound before the first tap or key press.
- Reduced motion (`prefers-reduced-motion`) drops the tremble, peek, hop, lunge and shake but keeps the flash, the crossed-out avatar and the full flow.
- Do not `git push` — the Usernode harness handles the push after each commit. Just `git commit`.