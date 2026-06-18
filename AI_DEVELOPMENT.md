# AI Development Guide

This document describes the architecture, conventions, and constraints that future AI assistants (and the humans working with them) need to understand before touching this codebase. Its purpose is to keep AI-assisted edits safe, focused, and consistent.

---

## Repository Layout

```
chess-stockfish/
├── public/
│   └── stockfish/              # Stockfish v18 lite WASM + JS worker (static assets)
├── server/
│   └── evalServer.ts           # Optional Node eval server (not required for the app)
├── src/
│   ├── App.tsx                 # Main screen component (~2200 lines — the core game loop)
│   ├── main.tsx                # React entrypoint
│   ├── App.css                 # Global styles
│   ├── stockfishEngine.ts      # Stockfish WASM worker wrapper (gameplay / move search)
│   ├── evaluationEngine.ts     # Stockfish WASM worker wrapper (eval bar / review mode)
│   ├── soundManager.ts         # Audio unlock + playback
│   ├── constants.ts            # App-wide constants and lookup tables
│   ├── components/
│   │   └── EvaluationBar.tsx   # Eval bar UI (only rendered in review mode)
│   ├── hooks/
│   │   └── useEvaluation.ts    # Hook: manages evaluationEngine lifecycle
│   ├── lib/
│   │   ├── supabase.ts         # Supabase client, type aliases, SavedGame type
│   │   └── stockfishWorkerUtils.ts  # Shared code between the two Stockfish engines
│   ├── types/
│   │   └── game.ts             # All game-domain TypeScript types
│   └── utils/
│       └── chessUtils.ts       # Pure utility functions (no React, no side effects)
├── supabase/
│   └── schema.sql              # Full DB schema (idempotent — safe to re-run)
├── .env.example                # Required environment variable names (no real secrets)
└── AI_DEVELOPMENT.md           # This file
```

---

## Key Files in Detail

### `src/App.tsx`
The entire game screen lives here. It handles:
- Auth routing (login, hub, game, review)
- Supabase game load / save / clock-persist
- Chess game state (via `chess.js` `Chess` object in a ref + state)
- Move input (clicks, drags, premoves)
- Stockfish interaction (requesting moves, receiving them)
- The player clock
- Move timeline navigation
- Board highlights
- Game completion / resign

This file is large by design — splitting it further risks hard-to-trace bugs in tightly coupled state. **Make targeted edits, not structural refactors**, unless you have a clear, small, verifiable goal.

### `src/stockfishEngine.ts` / `src/evaluationEngine.ts`
Each wraps a separate Stockfish WASM web worker. They are structurally similar but kept separate so the two engines run concurrently without blocking each other. Shared low-level utilities live in `src/lib/stockfishWorkerUtils.ts`.

### `src/utils/chessUtils.ts`
Pure functions only — no React hooks, no Supabase calls, no side effects. Keep it that way. Adding impure code here breaks the extraction rationale.

### `src/constants.ts`
Numeric constants, lookup tables, and the time control options array. Import from here; never hardcode magic numbers inline.

### `src/types/game.ts`
All game-domain TypeScript types that are not tied to Supabase or chess.js. If you add a new type shared across multiple files, put it here.

### `supabase/schema.sql`
The single source of truth for the database schema. Every column that exists in the DB should be represented here. When adding columns, use `ADD COLUMN IF NOT EXISTS` so the migration is re-runnable.

---

## Architecture Constraints

### Clock architecture
The player clock is **wall-clock-based**, not interval-accumulation-based.

- `clockStartedAtRef` — `Date.now()` value when the clock was last armed
- `clockStartingSecondsRef` — remaining seconds at that point

Every 250ms, the interval computes `remaining = clockStartingSeconds - (Date.now() - clockStartedAt)`. This design is immune to React effect restarts and browser tab throttling.

**Do not revert to a `previousTickAt` local variable approach.** The old approach caused resets when tabs were switched.

### Database clock persistence
`player_clock_started_at` is a `timestamptz` stored in the `games` row. On load, the app deducts elapsed time from it to determine how much time the player has left. This makes the clock survive game reloads and browser restarts.

### Two Stockfish workers
The gameplay engine (`stockfishEngine.ts`) and the eval bar engine (`evaluationEngine.ts`) are independent workers. Never share a single worker between them — concurrent `go` commands would corrupt both analyses.

### Supabase integer columns
`player_time_remaining_seconds` is an `integer` column. Always `Math.round()` clock values before writing to it. Never pass floats.

---

## Rules for AI Edits

1. **Do not rewrite the app from scratch.** The codebase has accumulated subtle state-machine logic. Start from the existing structure.

2. **Do not remove working features.** Feature removal requires explicit user confirmation.

3. **Do not delete files unless they are clearly unused.** Check imports before deleting.

4. **Prefer small, verifiable improvements.** After each change, verify with `tsc -b && vite build`.

5. **Keep gameplay behavior unchanged** unless you are fixing a clear, confirmed bug.

6. **Never commit secrets.** `.env` is gitignored. `.env.example` contains only placeholder values.

7. **Do not push to GitHub** unless the user explicitly asks.

8. **Run `npm run build` and `npm run lint` before committing.** Both must pass.

9. **If you extract code out of `App.tsx`**, verify the TypeScript build passes immediately after. TypeScript catches import errors that are easy to miss.

10. **Do not add abstraction layers** beyond what a specific task requires. The project is maintained primarily through AI prompts; unnecessary indirection makes future prompts harder.

---

## Adding New Features: Checklist

- [ ] Add any new TypeScript types to `src/types/game.ts`
- [ ] Add any new constants to `src/constants.ts`
- [ ] Add any new pure utility functions to `src/utils/chessUtils.ts`
- [ ] Add any new DB columns to `supabase/schema.sql` with `ADD COLUMN IF NOT EXISTS`
- [ ] Update `src/lib/supabase.ts` `SavedGame` type if you add DB columns
- [ ] Run `npm run build` — must pass with 0 errors
- [ ] Run `npm run lint` — must pass with 0 warnings

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | Yes | Supabase project URL (from project settings) |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase anon/public key (from project settings) |
| `STOCKFISH_PATH` | No | Path to native Stockfish binary (only for optional eval server) |

All `VITE_` variables are compiled into the browser bundle by Vite. Do not put secrets in `VITE_` variables — they are visible in the built output.

---

## Common Pitfalls

| Pitfall | Correct approach |
|---------|-----------------|
| Passing float to `player_time_remaining_seconds` | Always `Math.round()` before DB write |
| Resetting clock on tab-out | Use `clockStartedAtRef` / `clockStartingSecondsRef` refs, not local interval vars |
| Forgetting to apply schema migrations | Run `supabase/schema.sql` in Supabase SQL Editor after adding columns |
| Importing `SavedGame` from the wrong place | It lives in `src/lib/supabase.ts` |
| Hardcoding time control values | Use `TIME_CONTROL_OPTIONS` from `src/constants.ts` |
| Adding impure code to `chessUtils.ts` | Keep that file pure — no hooks, no Supabase, no side effects |
| Sharing a single Stockfish worker between gameplay and eval | Always keep them as separate workers |

---

## Build and Lint Commands

```sh
npm run dev          # Vite dev server with HMR
npm run build        # TypeScript check + Vite production build
npm run preview      # Serve production build locally
npm run lint         # ESLint
```
