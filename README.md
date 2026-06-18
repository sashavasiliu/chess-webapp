# Chess vs Stockfish

A browser-based chess web app with full account backing, game history, and client-side Stockfish for both move search and position evaluation.

## Features

- Play as White or Black against Stockfish
- Hub: start games, resume active games, view game history
- Drag-and-drop and click-to-move controls
- Premove support while Stockfish is thinking
- Legal move, capture, selected-square, hover, and premove highlights
- Board orientation follows player color (Black side plays from the bottom)
- Time controls: Infinite, Bullet (1, 1+1, 2+1), Blitz (3, 3+5, 5), Rapid (10, 10+5, 15+10)
- Player-only clock with increment support
- Clock continues ticking through tab switches and game reloads
- Timeout loss detection
- Resign button with confirmation
- Move timeline with first / previous / next / latest navigation
- Animated timeline move playback
- Captured-piece rows with material advantage display
- Move, capture, check, checkmate, and promotion sounds
- Game review mode: full timeline navigation with Eval Bar, no move input
- Client-side Stockfish evaluation bar (depth streaming, mate detection)
- Sign in / sign up with Supabase auth
- All games saved to Supabase with PGN, timeline, clock state, and end reason
- New game setup screen: choose side and time control before starting

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript |
| Build | Vite |
| Routing | React Router v7 |
| Chess logic | chess.js |
| Board UI | react-chessboard |
| Stockfish (gameplay) | WASM worker — `stockfishEngine.ts` |
| Stockfish (eval bar) | WASM worker — `evaluationEngine.ts` |
| Database / Auth | Supabase |
| Optional eval server | Node.js — `server/evalServer.ts` (not required) |

## Requirements

- Node.js 20 or newer
- npm
- A [Supabase](https://supabase.com) project (free tier is fine)

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your Supabase project values:

```sh
cp .env.example .env
```

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

### 3. Apply the database schema

Open your Supabase project → SQL Editor, then run the contents of `supabase/schema.sql`.

The schema is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) so it is safe to re-run after updates.

### 4. Start the dev server

```sh
npm run dev
```

Vite prints the local URL (usually `http://localhost:5173`).

If Supabase environment variables are missing, the app shows a setup screen instead of the authenticated hub.

## Stockfish Assets

The browser engines load from `public/stockfish/`. The repo already includes the v18 lite single-threaded build:

```
public/stockfish/stockfish-18-lite-single.js
public/stockfish/stockfish-18-lite-single.wasm
```

Two independent WASM workers run in parallel:
- **`stockfishEngine.ts`** — opponent move search (difficulty tunable via depth)
- **`evaluationEngine.ts`** — evaluation bar analysis (independent depth, only active in review mode)

This keeps opponent search and analysis from blocking each other.

## Database Schema

All schema migrations live in `supabase/schema.sql`. Key tables:

| Table | Purpose |
|-------|---------|
| `profiles` | Display name per user |
| `preferences` | Per-user sound and depth defaults |
| `games` | Full game state: PGN, timeline JSON, player color, time control, clock, end reason |

After adding new columns, run the migration SQL in the Supabase SQL Editor. No migration tooling is required.

## Build

```sh
npm run build
```

Output goes to `dist/`. The build is a fully static site — no server required.

```sh
npm run preview   # serve the production build locally
```

## Lint

```sh
npm run lint
```

## Optional: Native Eval Server

`server/evalServer.ts` is a Node.js HTTP server that wraps a native Stockfish binary for higher-quality evaluation. It is **not required** — the browser WASM engine is used by default.

To run it (requires a native Stockfish binary):

```sh
# Set STOCKFISH_PATH in .env, then:
npm run dev:server
```

The frontend falls back to the browser engine automatically if the server is unavailable.

## Known Limitations

- No two-player (local or online) support
- No opening trainer or puzzle library (planned)
- Stockfish difficulty is set by depth, not Elo
- No promotion choice dialog — promotions always default to queen
- Bundle is ~600 KB (Stockfish WASM is large; code-splitting is a future improvement)
