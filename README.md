# Chess Webapp

Chess web app with Stockfish, premoves, timeline navigation, sounds, and captured-piece display.

## Features

- Play as White against the bundled Stockfish engine.
- Drag-and-drop and click-to-move controls.
- Premove support while Stockfish is thinking or Black is to move.
- Legal move, capture, selected-square, hover, and premove highlights.
- Move timeline with first, previous, next, and latest position navigation.
- Animated timeline move playback.
- Captured-piece rows with material advantage.
- Move, capture, check, checkmate, and promotion sounds.
- Local native Stockfish evaluation bar for the displayed timeline position.
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

## Local Native Evaluation

The app can show a local native Stockfish evaluation bar beside the board. The browser Stockfish worker still handles gameplay; the local Node server is only for evaluation.

Set `STOCKFISH_PATH` to your native Stockfish executable, then run the eval server and app in two terminals:

```powershell
$env:STOCKFISH_PATH="C:\Tools\Stockfish\stockfish-windows-x86-64-avx2.exe"
npm run dev:server
```

```powershell
npm run dev:app
```

The app calls `GET /api/eval?fen=<encodedFen>&depth=14` through the Vite dev proxy. If the eval server is not running, or `STOCKFISH_PATH` is missing or invalid, the board remains playable and the eval bar shows `local eval offline`.

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
