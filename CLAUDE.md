# Awas Ada Pocong — Developer Guide

This app runs on **Usernode Social Vibecoding**. Platform-wide rules live at:
**https://social-vibecoding.usernodelabs.org/claude.md**

Fetch that URL at the start of each session. If a rule below conflicts with the hosted conventions, **the hosted conventions win**. This file covers app-specific details only.

---

## 1. Game concept

**Awas Ada Pocong** ("Watch Out, There's a Pocong") is a single-player
horror-comedy hide-and-seek game on an isometric **Mansion Level 1 Hallway Map**
blueprint (pale grid paper, black line work, hand-drawn furniture, a north
arrow bottom-left) with a dark parchment-framed side panel on the right.

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

An optional **daring second pick** (the side panel's "Double Down" step, the
points-only replacement for the original x2 money double-down) lets a locked-in
player also dare a second room. If the Pocong enters either room they are
found; surviving both multiplies the round's points by 1.5.

- Genre: Indonesian horror-comedy (Pocong is a traditional Indonesian ghost).
- Visual tone: B&W cartoon isometric blueprint with red accents; Creepster
  horror font. The side panel is dark parchment (`#1a1613` on `#c8b48c`
  double rules); the primary action stays the app purple `#7c3aed`.
- Language: the map and the side panel use the reference art's English labels
  ("Master Bedroom", "Player Setup: Select & Confirm"); result banners, the
  intro and the sound toggle keep their Indonesian copy.

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
        ├── pocong.jpg         # Pocong photo, used only by the jump-scare overlay
        ├── hatch.png          # 128x128 diagonal-hatch texture (currently unused)
        └── ui-reference.png   # Reference screenshot from the design phase (ignore)
```

There is **no build step**. `index.html` loads the platform bridge
(`/usernode-bridge/v1/bridge.js`) for identity and time, and nothing else. The
map, the Pocong on the map and the avatars are hand-drawn inline SVG, not a
rendering library.

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

The main hallway runs along `gridX = 2` (`gridZ` -1..5, top-right to
bottom-left on screen). Rooms sit on either side, one tile each, ordered so
that their position along the hallway matches the server's `step` value used
for scoring (near the entrance first).

| slug | label | gridX | gridZ | furniture type |
|---|---|---|---|---|
| `kitchen-area` | Kitchen | 1 | 0 | kitchen |
| `kamar-anak` | Kids' Bedroom | 1 | 1 | kids |
| `kamar-utama` | Master Bedroom | 1 | 2 | bedroom |
| `library` | Library | 1 | 3 | library |
| `kamar-asisten` | Assistant's Room | 1 | 4 | assistant |
| `gudang` | Gudang (Storage) | 1 | 5 | storage |
| `kamar-mandi-kedua` | Secondary Bathroom | 3 | 0 | bathroom |
| `kamar-mandi` | Bathroom | 3 | 1 | bathroom |
| `backyard` | Backyard | 3 | 2 | backyard |
| `ruang-baca` | Reading Room | 3 | 3 | reading |
| `living-room` | Living Room | 3 | 4 | living |

The former `laundry-area` and `playing-room` rooms were removed when the map
was trimmed to 11; their old `bets` rows are untouched because that table is
no longer read.

## 5. Visual spec — 2D isometric SVG map

The scene is a single inline `<svg id="game-svg">` (viewBox `0 0 1100 680`)
inside `#map-wrap` (the left column), drawn at load by `buildMap()`. There is
no Three.js, no camera and no WebGL.

- Isometric projection: `ISO = { hw: 96, hh: 55, wallH: 18, ox: 585, oy: 140 }`,
  `iso(gx, gz) = { x: ox + (gx - gz) * hw, y: oy + (gx + gz) * hh }`.
- Paper: `#f3efe3` with a minor/major grid pattern and a double hand-drawn
  frame; title block "Mansion Level 1 Hallway Map" top-left, north arrow
  bottom-left, legend bottom-right.
- Painter order: rooms sorted by `gridX + gridZ` (back to front). Per room:
  floor diamond, the two far walls, furniture, then the two near walls, so
  every room reads as a low-walled hexagon (cutaway walls, 18px high, so the
  rooms on the near side of the hallway never hide it).
- Each room has a **door** onto the hallway: a gap in the hallway-facing wall
  (`DOOR_GAP`), a leaf line, a dashed swing arc and a small "Door" caption.
  `roomGeo[slug].door` is the point on the threshold the Pocong walks to.
- Room labels are white tags outside the map with a dashed leader to the
  room's outer wall. The furniture per type lives in `FURN` (hand-drawn iso
  cuboids via `cub()` plus detail lines); `SPOT` gives the avatar's hiding
  spot per type.
- The **main hallway** is one diagonal strip along `gridX = 2` with a hatched
  floor, a "Main Entrance / START" mark at the top-right end, the dashed red
  Pocong Route down the middle with faint static footprints, and the labels
  "Main Hallway (Pocong Route)" and "Pocong Route" rotated along it.
- Layers, in draw order: `layer-paper`, `layer-rooms`, `layer-route`,
  `layer-tint`, `layer-figures`, `layer-ghost`, `layer-labels`,
  `layer-hotspots`.
- Hunt phase: `#map-wrap.hunt` fades in `layer-tint` (a flat dim plus a radial
  vignette), the Pocong's glow turns red, and once it arrives the target room's
  hotspot lights red (`.hotspot.target`). `#map-wrap.resolved` stops the
  avatars trembling.

## 6. Interaction

- Hiding rooms have a transparent hotspot polygon (`hotspotEls[slug]`). Hover
  tints it red, a selected room `.selected`, a locked-in room purple
  (`.hotspot.locked`), the daring pick orange (`.daring`) and the Pocong's
  target red (`.target`). A click selects it (`selectRoom`), which also
  updates the side panel's dropdown and grid button; those controls call the
  same `selectRoom`.
- Avatars are drawn SVG cartoon figures (`makeAvatar`): wide eyes, worried
  brows, open mouth, a sweat drop, trembling via the `.fig-body` CSS animation
  (off under reduced motion). The viewer's own avatar carries a purple "YOU"
  tag at the room's `SPOT`; other players (the `hides` rows) carry their
  initial and are spread in a spiral. An eliminated viewer gets a red slash.
- The Pocong on the map is drawn SVG (`#pocong`: wrapped body, knot, face)
  over a blurred glow ellipse. It rests at the entrance in the hiding phase
  and in the hunt walks the route (time-based, `WALK_SECONDS` 4.6s) to the
  point nearest the target's door, then onto the threshold, dropping fading
  red footprints (`dropFootprint`). `pocong.jpg` is only the jump-scare image.

## 7. UI layout

`#game` is a two-column flex layout: `#map-wrap` (the map, flexible) and
`#phase-panel` (332px, scrolls on its own). Under 768px they stack, map first,
and the page scrolls.

| Element | Where | Description |
|---|---|---|
| `#map-banner` | centre of the map, over the hallway (top of the map during the hunt) | Dark banner: "HIDING PHASE" + "Remaining Hiding Time" + `#hiding-timer`; "POCONG PHASE" / "ROUND OVER" later |
| `#btn-mute` | top-right of the map | Sound toggle: "🔊 Suara: Nyala" / "🔇 Suara: Mati". Always visible, both phases. |
| `#dev-controls` | bottom-left of the map (bottom-right on phones) | Staging-only Next Phase button |
| `#title` | top of the side panel | "Awas Ada Pocong" in Creepster over a double rule |
| Current Game Phase | panel step 1 | `#phase-banner`: "Hiding Phase: 00:39", "Pocong Phase: the hunt", "Round N over" |
| Player Setup: Select & Confirm | panel step 2 | `#room-select` dropdown, `#room-grid` (3 columns, 11 buttons), "User Location: `#location-state`" (NOT LOCKED / LOCKED IN · room / SPECTATOR LOUNGE) |
| Confirm & Place | panel step 3 | `#signature` box with the player's initials (`#sig-initials`) and "Signed as `#player-name`", `#btn-confirm` CONFIRM & PLACE, `#phase-note` |
| Double Down: Daring Pick | panel step 4 | `#daring-select` + `#btn-daring` (enabled once locked, hiding phase only), `#daring-note` |
| Status | panel step 5 | Score, This round, Best round, Streak (multiplier) tiles; `#status-light` (amber / green / red) + `#status-text` ("Hiding Phase Complete. Location Locked." etc.); `#btn-leaderboard` |
| `#result-banner` | center overlay | Eliminated / survived / timeout while a round is resolved |
| `#jumpscare` + `#flash` | fixed overlays | The elimination scare |
| `#leaderboard-overlay` | centered overlay | Top-20 leaderboard |

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
| POST | `/api/game/daring` | `{ room_slug }` | Dare a second room after locking. 400 outside the 11 or same as the locked room, 409 if not locked, phase ended or already dared. |
| POST | `/api/game/advance` | `{}` | Staging or admin: force the next phase transition |

`my_hide` also carries `daring_room_slug` (null when none).

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
- At `hunt -> resolved`, points are computed and stats written.
- The round stays `resolved` for `RESULT_MS` (8s) so the client can show the
  result banner, the jump-scare and the lit target room; then the next
  `hiding` round is inserted (guarded so it happens once). The staging
  `advance` button follows the same steps one click at a time.

**Self-healing.** `runTransitions` also repairs state a production database
may carry from an older version of the game, so no manual action or DB reset
is ever needed to get a round running. `timeOf(v)` reads a stored timestamp
(null when missing or unparseable) and `openNextRound(now, afterNumber)`
holds the guarded insert of the next hiding round:

- **Empty `rounds` table** (production, non-staging): the first round
  (`round_number` 1, `hiding`, +60s) is opened on boot — `start()` runs
  `runTransitions(new Date())` after `migrate()`, never blocking boot — and on
  the first poll.
- **Legacy statuses** (`active`, `resolving`, `completed`, unknown, from the
  pre-hiding game): the row is left untouched; the next round opens after it
  (`round_number` continues from the highest existing one).
- **Stale `hiding`**: deadline null/unparseable, or more than
  `HUNT_MS + RESULT_MS` past: the round is settled in place (resolved and
  scored, no hunt replayed) and the next round opens.
- **Stale `hunt`**: `hunt_ends_at` null/unparseable, or more than `RESULT_MS`
  past: resolved and scored (target `COALESCE`d so it is never lost), next
  round opens.
- **`resolved` with `resolved_at` null**: the next round opens at once.

Live rounds (deadlines only just passed) keep the normal timed path; the
inserts keep the `NOT EXISTS` guard and the flips stay conditional `UPDATE
... WHERE status = ...`.

### Scoring (`resolveRound`)

For each locked player:

- eliminated (Pocong in their room, or in their daring second room): 0
  points, streak reset.
- survived: `(100 + 25 * route_step + scarcity) * min(3, 1 + 0.1 * streak)`,
  where `scarcity = min(300, round(50 * total_players / players_in_room))`,
  then `x1.5` (rounded) when a daring second room was set.

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
  daring_room_slug VARCHAR(100),                  -- optional second (daring) room
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

A failed poll (non-2xx or a thrown fetch) sets the `connectionLost` flag: the
**Current Game Phase** box shows "Reconnecting..." and the status line turns
amber with "Lost the connection. Reconnecting." while the map countdown keeps
its `hiding_ends_at`-derived value. The next successful poll clears it.

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
- A heart-rate visualiser on the avatar and the survival relief animation
  (the avatars tremble; the hunt only speeds the tremble up).
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
  the Pocong entered your room or your daring room (bad); `'disqualified'` =
  you never locked in; `'pending'` = locked in, not yet resolved.
- The daring pick is points-only risk/reward (x1.5, double exposure). It is
  never a stake and never a money multiplier.
- The jump-scare sting is routed through its own gain node (`stingGain`) and is
  the loudest moment by construction. The mute toggle controls only
  `ambienceGain`. Do not route the sting through the ambience bus.
- The 60-second countdown is never a decrementing counter: derive it from
  `hiding_ends_at` on every tick and on `visibilitychange` / `pageshow`.
- Do not `git push` — the Usernode harness handles the push after each commit.
  Just `git commit`.
