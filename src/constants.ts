import type { PieceSymbol } from "chess.js";
import type { PlayerColor } from "./lib/supabase";
import type { TimeControlOption } from "./types/game";

export const DEFAULT_DEPTH = 10;
export const DEFAULT_EVALUATION_DEPTH = 26;
export const STOCKFISH_REPLY_DELAY_MS = 1000;
export const STOCKFISH_DRAG_RETRY_DELAY_MS = 150;
export const TIMELINE_MOVE_ANIMATION_MS = 220;
export const CLOCK_PERSIST_INTERVAL_MS = 5000;
export const DEFAULT_PLAYER_COLOR: PlayerColor = "w";

export const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export const CAPTURED_PIECE_ORDER: PieceSymbol[] = ["q", "r", "b", "n", "p"];

export const CAPTURED_PIECE_SYMBOLS: Record<"w" | "b", Record<PieceSymbol, string>> = {
  w: {
    p: "♙",
    n: "♘",
    b: "♗",
    r: "♖",
    q: "♕",
    k: "♔",
  },
  b: {
    p: "♟",
    n: "♞",
    b: "♝",
    r: "♜",
    q: "♛",
    k: "♚",
  },
};

export const TIME_CONTROL_OPTIONS: TimeControlOption[] = [
  { label: "Infinite", group: "Infinite", baseSeconds: null, incrementSeconds: 0 },
  { label: "1", group: "Bullet", baseSeconds: 60, incrementSeconds: 0 },
  { label: "1+1", group: "Bullet", baseSeconds: 60, incrementSeconds: 1 },
  { label: "2+1", group: "Bullet", baseSeconds: 120, incrementSeconds: 1 },
  { label: "3", group: "Blitz", baseSeconds: 180, incrementSeconds: 0 },
  { label: "3+5", group: "Blitz", baseSeconds: 180, incrementSeconds: 5 },
  { label: "5", group: "Blitz", baseSeconds: 300, incrementSeconds: 0 },
  { label: "10", group: "Rapid", baseSeconds: 600, incrementSeconds: 0 },
  { label: "10+5", group: "Rapid", baseSeconds: 600, incrementSeconds: 5 },
  { label: "15+10", group: "Rapid", baseSeconds: 900, incrementSeconds: 10 },
];

export const DEFAULT_TIME_CONTROL = TIME_CONTROL_OPTIONS[0] as TimeControlOption;
