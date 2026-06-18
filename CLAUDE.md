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

A multiplayer survival hide-and-seek game in a 1930s rubber-hose cartoon aesthetic. Players stake play-money tokens, hide in mansion rooms, and try to survive the pocong (wrapped ghost) each round. Last survivors split the pot. Always 50 characters in-lobby via bot backfill for a populated feel.

## App-specific conventions

- **Play-money only:** integer token values (cents equivalent internally), no on-chain currency. Bots' winnings are discarded; only real survivors get paid out.
- **Round loop state machine:** phases are lobby → hiding → reveal → results, driven by a Postgres-guarded ticker (~750ms) with advisory locks to prevent overlaps.
- **Real-time via polling:** client polls `/api/round/state` every ~1s; no WebSocket support on the platform.
- **Bot roster is always seeded:** 60 bot names seeded on every boot in all environments (core gameplay, not staging-only). Real users are identified by non-null `user_id` in `round_participants`.
- **All tables public:** no private tables (no DMs, no real financial data beyond play-money balances). Staging gets a copy of prod data plus seeded demo accounts/completed rounds for testing.
