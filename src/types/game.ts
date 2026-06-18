import type { Square, PieceSymbol } from "chess.js";
import type { GameResult, GameEndReason } from "../lib/supabase";

export type EngineStatus = "loading" | "ready" | "failed";
export type ActiveSource = "click" | "drag";

export type Premove = {
  from: Square;
  to: Square;
  promotion?: "q" | "r" | "b" | "n";
};

export type TimelineEntry = {
  ply: number;
  fen: string;
  san?: string;
  uci?: string;
  from?: Square;
  to?: Square;
  promotion?: string;
  captured?: PieceSymbol;
  moveNumber?: number;
  color?: "w" | "b";
};

export type TimelineAnimation = {
  key: number;
  from: Square;
  to: Square;
  piece: string;
};

export type MoveRow = {
  moveNumber: number;
  white?: TimelineEntry;
  black?: TimelineEntry;
};

export type GameSnapshot = {
  fen: string;
  pgn: string;
};

export type CapturedPieces = {
  byWhite: PieceSymbol[];
  byBlack: PieceSymbol[];
};

export type GameScreenMode = "play" | "review";

export type TimeControlOption = {
  label: string;
  group: "Infinite" | "Bullet" | "Blitz" | "Rapid";
  baseSeconds: number | null;
  incrementSeconds: number;
};

export type SavedGameCompletion = {
  status: "active" | "completed";
  result: GameResult;
  completedAt: string | null;
  endReason: GameEndReason;
};
