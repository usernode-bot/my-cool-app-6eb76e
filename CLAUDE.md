# my cool app — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Awas Ada Pocong

A multiplayer **room-betting** game in a 1930s rubber-hose cartoon aesthetic. During a betting window each player stakes play-money tokens on the mansion rooms they predict are *safe* (click a room to stake the current standard bet; multiple rooms allowed, clicks stack). The pocong (wrapped ghost) then haunts exactly ONE room, chosen server-side uniformly at random: bets on the haunted room are lost, bets on every safe room pay out 2×. The board is kept lively with bot bets via backfill.

## App-specific conventions

- **Play-money only:** integer token values, no on-chain currency. Bets are debited on placement and refunded on clear (betting phase only). Only **real** participants are credited at resolution; **bot winnings are discarded** to control the faucet (~7% house edge: 2× over 14 rooms).
- **Round loop state machine:** phases are **betting (~20s) → reveal (~6s) → results (~8s)**, no sub-rounds, driven by a Postgres-guarded ticker (~750ms) with an advisory lock (`LOCK_ID 1001`). Payout resolution runs once inside the advisory-locked reveal transition, in a DB transaction.
- **14 rooms:** the `ROOMS` array in `server.js` and `public/index.html` MUST stay identical (a mismatch makes `/api/round/bet` reject valid clicks).
- **Real-time via polling:** client polls `/api/round/state` every ~1s; no WebSocket support on the platform.
- **Endpoints:** `GET /api/round/state`, `POST /api/round/bet {room,amount}`, `POST /api/round/clear {room?}`, `POST /api/round/join` (ensures account), `GET /api/leaderboard`. All auth-gated; `/health` is the only public route.
- **Data model:** `room_bets` has a unique `(round_id, participant_id, room)` for upsert-increment; `round_participants` gained `total_staked`/`net` (survival columns `current_room`/`alive`/`eliminated_subround` are now vestigial); `round_reveals.pocong_room` = the haunted room.
- **Bot roster is always seeded:** 60 bot names seeded on every boot in all environments (core gameplay, not staging-only). Real users are identified by non-null `user_id` in `round_participants`. Real players capped at 100/round.
- **All tables public:** no private tables (no DMs, no real financial data beyond play-money balances). Staging gets a copy of prod data plus seeded demo accounts + a completed round with resolved `room_bets`. `?demo=win` is a cosmetic, client-only win-tableau preview (no server calls).
