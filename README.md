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
