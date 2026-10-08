# Awas Ada Pocong — Developer Guide

This app runs on **Usernode Social Vibecoding**. Platform-wide rules live at:
**https://social-vibecoding.usernodelabs.org/claude.md**

Fetch that URL at the start of each session. If a rule below conflicts with the hosted conventions, **the hosted conventions win**. This file covers app-specific details only.

---

## 1. Game concept

**Awas Ada Pocong** ("Watch Out, There's a Pocong") is a single-player
horror-comedy hide-and-seek game on an isometric **Mansion Level 1 blueprint**
(pale paper background, black line work, hand-drawn furniture, a north arrow).

Each round has two phases:

1. **Hiding phase (60 seconds).** The player picks one of 11 hiding rooms and
   locks it in with **CONFIRM & PLACE**. The countdown is real: it is derived
   from an absolute end timestamp, so a backgrounded tab or a sleeping phone
   cannot stretch it. Letting it run to 00:00 without locking is a real loss:
   the player goes to the **Spectator Lounge**.
2. **Pocong phase.** An RNG picks exactly one room as the Pocong's target. The
   Pocong appears on the **Pocong Route** drawn along the main hallway and
   travels to that room's doorway, leaving fading footprints.

If the Pocong's room is the player's room the player is eliminated: a
jump-scare (flash, shake, slashed marker) and a reset to the Spectator Lounge.
Any other room means the player survives and scores.

- Genre: Indonesian horror-comedy (Pocong is a traditional Indonesian ghost).
- Visual tone: B&W cartoon isometric blueprint with red accents; Creepster
  horror font.
- Language: UI labels mix Indonesian and English, matching the existing copy.

**No gambling of any kind.** There is no stake, no wallet signing, no slash,
no multiplier payout, no coin balance. The game is scored in points only:
survival earns points (base + distance from the Pocong spawn + room scarcity,
times a survival streak), with a per-round score, a best score and a
leaderboard. Contests and leaderboards are allowed; wagering is not.

The app reasons in **UTC** (there is no per-group timezone logic).

## 2. File structure

```
/
├── server.js                  # Express server — DB migrations, auth, game API
├── package.json               # Dependencies: express, pg, jsonwebtoken
├── dapp.json                  # App manifest (name, icon, CI tests)
├── .gitignore                 # node_modules/
├── CLAUDE.md                  # This file
└── public/
    ├── index.html             # ENTIRE game — the SVG map + all UI (single file)
    └── assets/
        ├── pocong.jpg         # Pocong sprite (SVG <image> for the ghost and the jump-scare)
        ├── hatch.png          # 128x128 diagonal-hatch texture (currently unused)
        └── ui-reference.png   # Reference screenshot from the design phase (ignore)
```

There is **no build step**. `index.html` loads the platform bridge
(`/usernode-bridge/v1/bridge.js`) for identity and time, and nothing else. The
map is hand-drawn inline SVG, not a rendering library.

---

## 3. Stack & dependencies

| Layer | Tech |
|---|---|
| Server | Node.js / Express |
| Database | PostgreSQL via `pg` npm package |
| Auth | JWT (`jsonwebtoken`) — Usernode platform tokens (RS256) |
| Rendering | Inline SVG, drawn in JS (no Three.js, no WebGL) |
| Audio | Web Audio API (ambience bus + a separate sting bus) |
| Font | Google Fonts — Creepster (horror decorative) |
| CSS | Vanilla CSS in a `<style>` block inside `index.html` |

---

## 4. Room list

**11 hiding rooms** are selectable and are the only valid RNG targets. They are
the single source of truth in two places that must stay in sync: `VALID_ROOMS`
(here named `HIDING_ROOMS`) in `server.js`, and the `ROOMS` array (entries with
a non-null `slug`) in `public/index.html`.

| slug | label | gridX | gridZ |
|---|---|---|---|
| `kamar-utama` | Kamar Utama | 0 | 0 |
| `library` | Library | 1 | 0 |
| `kamar-asisten` | Kamar Asisten | 2 | 0 |
| `kitchen-area` | Kitchen Area | 0 | 1 |
| `kamar-anak` | Kamar Anak-Anak | 1 | 1 |
| `living-room` | Living Room | 3 | 1 |
| `kamar-mandi` | Kamar Mandi | 0 | 2 |
| `kamar-mandi-kedua` | Kamar Mandi Kedua | 1 | 2 |
| `backyard` | Backyard | 2 | 2 |
| `gudang` | Gudang | 3 | 2 |
| `ruang-baca` | Ruang Baca | 0 | 3 |

The remaining grid cells (the 4x4 grid minus the above) are non-selectable
hallway tiles: they render floor only, no label, no hotspot. The former
`laundry-area` and `playing-room` rooms were removed when the map was trimmed
to 11; their old `bets` rows are untouched because that table is no longer
read.

## 5. Visual spec — 2D isometric SVG map

The scene is a single inline `<svg id="game-svg">` (viewBox `0 0 1376 768`)
inside `#map-wrap`, drawn at load by `buildMap()`. There is no Three.js, no
camera and no WebGL (the file no longer imports them).

- Isometric projection: `ISO = { hw: 108, hh: 62, wallH: 72, ox: 688, oy: 172 }`,
  `iso(gx, gz) = { x: ox + (gx - gz) * hw, y: oy + (gx + gz) * hh }`.
- Painter order: rooms sorted by `gridX + gridZ` (back to front).
- Per room: a back-left wall, a back-right wall, and a floor diamond. Corridor
  tiles get floor only.
- Blueprint palette (both phases): floors `#fbf9f1`, left wall `#e4dfd0`, right
  wall `#d6d0bf`, hallway floor `#cfc9b8`, all with `#1a1a1a` strokes.
- Furniture: per room type in the `FURN` table, drawn as small iso cuboids by
  `drawCuboid()`.
- Layers, in draw order: `layer-rooms`, `layer-furn`, `layer-route`,
  `layer-tint`, `layer-figures`, `layer-ghost`, `layer-labels`,
  `layer-hotspots`.
- The **Pocong Route** is drawn once into `layer-route` as two polylines (a
  pale halo under a mid-tone dashed line) plus a label. It stays visible in
  both phases, including the dark hunt state.
- A north arrow and a `MANSION LEVEL 1` caption are drawn on pale chips so they
  read in either phase.
- Hiding phase: pale blueprint on a dark radial background. Pocong phase:
  `#map-wrap.hunt` darkens the backdrop; the map itself keeps the same line
  work.

## 6. Interaction

- Hiding rooms have a transparent hotspot polygon (`hotspotEls[slug]`). Hover
  tints it red; a locked-in room tints purple (`.hotspot.locked`); a click
  selects it (`selectRoom`).
- The player's own avatar is a purple ring + dot in the chosen room; other
  players (the `hides` rows) are small figure sprites placed in a spiral, as
  before.
- The Pocong sprite (from `pocong.jpg`) sits at the start of the route in the
  hiding phase, and in the hunt phase walks the route to the point nearest the
  target room, dropping fading footprints (`dropFootprint`).

## 7. UI layout

Fixed HTML elements layered over the SVG:

| Element | Position | Description |
|---|---|---|
| `#title` | top-center (top-left on mobile) | "👻 Awas Ada Pocong" in Creepster |
| `#compass-hint` | top-left | "👻 Ketuk ruangan untuk bersembunyi" (hidden on mobile) |
| `#btn-mute` | top-right | Sound toggle: "🔊 Suara: Nyala" / "🔇 Suara: Mati". Always visible, both phases. |
| `#phase-panel` | right: 16px, top: 78px (bottom sheet on mobile) | Phase banner, countdown, User Location, Player, score, CONFIRM & PLACE, Leaderboard |
| `#result-banner` | center overlay | Eliminated / survived / timeout after a round resolves |
| `#jumpscare` + `#flash` | fixed overlays | The elimination scare |
| `#dev-controls` | bottom-left | Staging-only Next Phase button |
| `#leaderboard-overlay` | centered overlay | Top-20 leaderboard |

The phase panel is a paper card styled like the old tutorial panel. The sound
button reuses the old bet-chip dark-pill styling.

### Sound toggle (hard requirement)

`#btn-mute` is fixed to the top-right corner of the map, is present in both
phases, and is the single master control for all ambience (heartbeat,
footsteps, breathing). Its state persists in `localStorage` under
`aap_muted_v1`. It never controls the jump-scare sting.

### Audio graph

`AUDIO` (an IIFE in `index.html`) builds a Web Audio graph:

- `ambienceGain` (gain 0.18 when unmuted, 0 when muted) is the bus the mute
  toggle controls. Heartbeat, footsteps and breathing all connect to it.
- `stingGain` (gain 1.0) is a **separate** node the mute toggle never touches.
  `playSting()` routes the jump-scare through it, so the sting is the single
  loudest moment by construction and muting cannot silence it.
- The `AudioContext` is created or resumed inside a user gesture (`AUDIO.init()`
  from the mute button or the first pointer/key event). Nothing autoplays.

## 8. Server API

### Public endpoints (no auth required)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{ status: 'ok' }` (503 once shutting down) |
| GET | `/api/game/env` | `{ isStaging, hidingMs, huntMs }` |
| GET | `/api/game/state` | The current round, the caller's hide, all hides, the caller's stats |
| GET | `/api/game/leaderboard` | `{ leaderboard: [...top 20 by best_score] }` |

`/api/game/state` response shape:

```json
{
  "round": { "id": 7, "round_number": 7, "status": "hiding", "target_room": null, "hiding_ends_at": "...", "hunt_ends_at": null },
  "my_hide": null,
  "hides": [{ "username": "staging-demo-user", "room_slug": "library", "outcome": "pending", "points_awarded": 0 }],
  "stats": { "total_score": 1240, "best_score": 1240, "current_streak": 3 },
  "server_now": "..."
}
```

`my_hide.outcome` may be `pending`, `survived`, `eliminated`, or
`disqualified`. A player who never locked gets `disqualified` computed at read
time in any post-hiding phase, so it works even though no row exists for them.

### Authenticated endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/api/game/hide` | `{ room_slug }` | Lock a hiding room. 400 outside the 11, 409 if the phase ended or already locked. |
| POST | `/api/game/advance` | `{}` | Staging or admin: force the next phase transition |

### State machine and time

`rounds.status` is `hiding` -> `hunt` -> `resolved`, then a new `hiding` round
opens. Transitions are **lazy and time-gated**: `runTransitions(req.now)` runs
at the top of `GET /api/game/state` (and each `advance` call) and moves the
round on when the stored deadline has passed. A browser polling is therefore
enough to expire the clock; no admin or background job is needed. Each flip is
a conditional `UPDATE ... WHERE status = <expected>` so two concurrent requests
cannot both pick a target.

- Round creation stores `hiding_ends_at = now + 60s`.
- At `hiding -> hunt`, `target_room` is drawn from the 11 slugs and
  `hunt_ends_at = now + 6s`.
- At `hunt -> resolved`, points are computed and stats written, then the next
  `hiding` round is created.

### Scoring (`resolveRound`)

For each locked player:

- eliminated (Pocong in their room): 0 points, streak reset.
- survived: `(100 + 25 * route_step + scarcity) * min(3, 1 + 0.1 * streak)`,
  where `scarcity = min(300, round(50 * total_players / players_in_room))`.

All integers. Nothing is deducted; there is no stake.

## 9. Database schema

Idempotent migrations run on every boot.

```sql
-- rounds: one row per round. winner_room is legacy (no longer written).
CREATE TABLE rounds (
  id SERIAL PRIMARY KEY,
  round_number INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'hiding',  -- hiding | hunt | resolved
  winner_room VARCHAR(100),
  target_room VARCHAR(100),                       -- RNG-chosen hiding slug
  hiding_ends_at TIMESTAMPTZ,
  hunt_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

-- hides: one lock-in per user per round. No amount, no balance.
CREATE TABLE hides (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  username VARCHAR(255) NOT NULL,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  room_slug VARCHAR(100) NOT NULL,
  locked_at TIMESTAMPTZ DEFAULT NOW(),
  outcome VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|survived|eliminated|disqualified
  points_awarded INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, round_id)
);

-- player_stats: score, streak and leaderboard source.
CREATE TABLE player_stats (
  user_id INTEGER PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  total_score BIGINT NOT NULL DEFAULT 0,
  best_score INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  rounds_survived INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

`bets` and `presses` still exist (created by earlier migrations, with their old
rows preserved) but nothing reads or writes them. Dropping them is deferred.

All three live tables are public (a stranger seeing every row is fine: a
username, a room slug and a score).

## 10. Staging seed data

On boot in staging, if `rounds` is empty:

1. One round `hiding` with `hiding_ends_at = now + 60s`, so the countdown is
   live.
2. A handful of `hides` on it from `staging-demo-user` / `staging-user-NN` in
   several rooms, so the map shows figures.
3. Six `player_stats` rows with varied `best_score` and `current_streak`, so the
   leaderboard renders with a real ranking.

All fake identities, `ON CONFLICT DO NOTHING`, gated on `if (IS_STAGING)`.

## 11. Polling

`setInterval(pollState, 2000)`. Each poll refreshes the phase, the figures, the
HUD and, on a resolved round, the result banner. `visibilitychange` and
`pageshow` trigger an immediate poll so a returning tab re-reads the truth.
The countdown is re-derived from `hiding_ends_at` on every frame and never
decremented.

## 12. Dev Controls panel (staging only)

`#btn-advance` calls `POST /api/game/advance` once per click, forcing
`hiding -> hunt -> resolved -> next hiding`. In production the same transitions
happen on the clock without it. The endpoint still guards admin in production.

## 13. Auth flow

Usernode injects a JWT as `?token=` on initial load. The frontend stores it in
`authHeaders` and sends it as `x-usernode-token` on all API requests. The server
verifies it with `USERNODE_JWT_PUBLIC_KEY` (RS256, issuer `usernode`, audience
`usernode:app:<USERNODE_APP_ID>`, purpose `iframe`) and populates
`req.user = { id, username, usernode_pubkey, locale }`.

Public routes: `/health`, `/api/game/state`, `/api/game/env`,
`/api/game/leaderboard`. All others require a valid token.

"Time now" is read through the platform (`usernode.now()` in the page,
`req.now` on the server) per the time-dependent-features convention, so a
staging preview can be shown at a chosen moment. The app's clock logic is in
UTC.

---

## 14. Known issues / what still needs work

### Deferred features

- Animated Pocong walk cycle (the sprite slides along the route; no leg
  animation).
- Dropping the legacy `bets` and `presses` tables once nothing reads them.
- The optional second, more daring pick mentioned in the original brief.
- WebSocket real-time updates (the 2s poll stays).
- A leaderboard that recomputes from full history for a long-lived season.

### Other notes

- `public/assets/hatch.png` and `ui-reference.png` are not referenced in code.
- Server-side points constants live in `resolveRound`; tune them there.
- `package.json` has no `files` entry — run `npm install` before `npm start` in
  a fresh environment.

---

## 15. App-specific conventions

- **No wagering.** No stake, no wallet signing, no slash, no multiplier payout,
  no coin balance. Points, streak and leaderboard only. Do not reintroduce any
  TKN amount, chip, balance or payout copy.
- `HIDING_ROOMS` in `server.js` and the slugged `ROOMS` entries in
  `index.html` are the single source of truth for the 11 hiding rooms and must
  stay in sync. A new room needs both.
- `target_room` and `hides.room_slug` use room slug strings (e.g.
  `'kamar-utama'`), not IDs.
- `hides.outcome`: `'survived'` = you were elsewhere (good); `'eliminated'` =
  the Pocong entered your room (bad); `'disqualified'` = you never locked in;
  `'pending'` = locked in, not yet resolved.
- The jump-scare sting is routed through its own gain node (`stingGain`) and is
  the loudest moment by construction. The mute toggle controls only
  `ambienceGain`. Do not route the sting through the ambience bus.
- The 60-second countdown is never a decrementing counter: derive it from
  `hiding_ends_at` on every tick and on `visibilitychange` / `pageshow`.
- Do not `git push` — the Usernode harness handles the push after each commit.
  Just `git commit`.
