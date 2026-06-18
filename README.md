# Chess Webapp

Chess web app with Stockfish, premoves, timeline navigation, sounds, and captured-piece display.

## Features

- Play as White against the bundled Stockfish opponent engine.
- Drag-and-drop and click-to-move controls.
- Premove support while Stockfish is thinking or Black is to move.
- Legal move, capture, selected-square, hover, and premove highlights.
- Move timeline with first, previous, next, and latest position navigation.
- Animated timeline move playback.
- Captured-piece rows with material advantage.
- Move, capture, check, checkmate, and promotion sounds.
- Client-side Stockfish evaluation bar for the displayed timeline position.
- New game reset.

## Requirements

- Node.js 20 or newer
- npm

## Install

```sh
npm install
```

## Run Locally

```sh
npm run dev
```

Vite prints the local development URL after the server starts.

The opponent engine and evaluation engine both run in the browser from the bundled Stockfish assets. No native Stockfish install, `STOCKFISH_PATH`, or eval server is needed.

## Browser Evaluation

The app uses two separate Stockfish worker instances:

- `src/stockfishEngine.ts` powers the opponent move search and can be tuned for difficulty.
- `src/evaluationEngine.ts` powers the evaluation bar and runs independently from opponent difficulty.

This keeps gameplay and analysis from canceling or delaying each other. If the browser Stockfish assets fail to load, the board remains playable and the evaluation bar shows a failed state.

`server/evalServer.ts` is legacy/dev-only native evaluation code and is not required for the hosted static app.

## Build

```sh
npm run build
```

The production build is written to `dist/`.

## Preview Production Build

```sh
npm run preview
```

## Notes

Stockfish assets are bundled under `public/stockfish`, and chess sounds are bundled under `public/sounds`, so the app can run without a separate chess engine service.
