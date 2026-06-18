import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import { type ChessSoundEvent } from "../soundManager";
import {
  type GameResult,
  type GameEndReason,
  type PlayerColor,
  type SavedGame,
} from "../lib/supabase";
import {
  type EngineStatus,
  type TimelineEntry,
  type MoveRow,
  type GameSnapshot,
  type CapturedPieces,
  type TimeControlOption,
  type SavedGameCompletion,
} from "../types/game";
import {
  PIECE_VALUES,
  CAPTURED_PIECE_ORDER,
  DEFAULT_DEPTH,
} from "../constants";

export function isSquare(value: string | null): value is Square {
  return /^[a-h][1-8]$/.test(value ?? "");
}

export function getSoundForMove(gameAfterMove: Chess, move: Move): ChessSoundEvent {
  if (gameAfterMove.isCheckmate()) return "checkmate";
  if (gameAfterMove.isCheck()) return "check";
  if (move.promotion) return "promote";
  if (move.captured) return "capture";
  return "move";
}

export function getSoundForTimelineEntry(entry: TimelineEntry): ChessSoundEvent {
  const gameAfterMove = new Chess(entry.fen);
  if (gameAfterMove.isCheckmate()) return "checkmate";
  if (gameAfterMove.isCheck()) return "check";
  if (entry.promotion) return "promote";
  if (entry.san?.includes("x")) return "capture";
  return "move";
}

export function cloneGameWithHistory(gameToClone: Chess) {
  const gameCopy = new Chess();
  const pgn = gameToClone.pgn();
  if (pgn) {
    gameCopy.loadPgn(pgn);
  }
  return gameCopy;
}

export function getGameSnapshot(gameToSnapshot: Chess): GameSnapshot {
  return {
    fen: gameToSnapshot.fen(),
    pgn: gameToSnapshot.pgn(),
  };
}

export function loadGameSnapshot(snapshot: GameSnapshot) {
  const gameCopy = new Chess();
  if (snapshot.pgn) {
    gameCopy.loadPgn(snapshot.pgn);
  } else {
    gameCopy.load(snapshot.fen);
  }
  return gameCopy;
}

export function isTimelineEntry(value: unknown): value is TimelineEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.ply === "number" && typeof entry.fen === "string";
}

export function parseSavedTimeline(value: unknown) {
  if (!Array.isArray(value)) return createInitialTimeline();
  const timeline = value.filter(isTimelineEntry);
  return timeline.length > 0 ? timeline : createInitialTimeline();
}

export function createInitialTimeline(): TimelineEntry[] {
  return [{ ply: 0, fen: new Chess().fen() }];
}

export function getSavedGameStatus(gameToCheck: Chess): SavedGameCompletion {
  if (!gameToCheck.isGameOver()) {
    return {
      status: "active",
      result: "ongoing",
      completedAt: null,
      endReason: "ongoing",
    };
  }

  const completedAt = new Date().toISOString();

  if (gameToCheck.isDraw()) {
    return {
      status: "completed",
      result: "draw",
      completedAt,
      endReason: "draw",
    };
  }

  return {
    status: "completed",
    result: gameToCheck.turn() === "w" ? "black" : "white",
    completedAt,
    endReason: "checkmate",
  };
}

export function getOpponentResult(playerColor: PlayerColor): GameResult {
  return playerColor === "w" ? "black" : "white";
}

export function getPlayerColor(savedGame: Partial<SavedGame> | null | undefined): PlayerColor {
  return savedGame?.player_color === "b" ? "b" : "w";
}

export function getTimeControlFromSavedGame(savedGame: Partial<SavedGame> | null | undefined) {
  return {
    label: savedGame?.time_control_label ?? "Infinite",
    baseSeconds: savedGame?.base_seconds ?? null,
    incrementSeconds: savedGame?.increment_seconds ?? 0,
    remainingSeconds: savedGame?.player_time_remaining_seconds ?? null,
  };
}

export function getInitialRemainingSeconds(timeControl: TimeControlOption) {
  return timeControl.baseSeconds;
}

export function isTimedGame(baseSeconds: number | null) {
  return baseSeconds !== null;
}

export function formatClock(seconds: number | null) {
  if (seconds === null) return "∞";
  const boundedSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(boundedSeconds / 60);
  const remainingSeconds = boundedSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function getTimeControlDescription(option: TimeControlOption) {
  if (option.baseSeconds === null) return "No clock";
  if (option.incrementSeconds === 0) return `${formatClock(option.baseSeconds)} base`;
  return `${formatClock(option.baseSeconds)} + ${option.incrementSeconds}s`;
}

export function getMoveNumberForPly(ply: number) {
  return Math.ceil(ply / 2);
}

export function getRenderedPieceCode(fen: string, square: Square) {
  const piece = new Chess(fen).get(square);
  if (!piece) return null;
  return `${piece.color}${piece.type.toUpperCase()}`;
}

export function sortCapturedPieces(pieces: PieceSymbol[]) {
  return [...pieces].sort(
    (a, b) => CAPTURED_PIECE_ORDER.indexOf(a) - CAPTURED_PIECE_ORDER.indexOf(b),
  );
}

export function getCapturedPiecesFromTimeline(
  timeline: TimelineEntry[],
  currentPlyIndex: number,
): CapturedPieces {
  return timeline.slice(1, currentPlyIndex + 1).reduce<CapturedPieces>(
    (capturedPieces, entry) => {
      if (!entry.captured || entry.captured === "k") {
        return capturedPieces;
      }
      if (entry.color === "w") {
        capturedPieces.byWhite.push(entry.captured);
      } else if (entry.color === "b") {
        capturedPieces.byBlack.push(entry.captured);
      }
      return capturedPieces;
    },
    { byWhite: [], byBlack: [] },
  );
}

export function getCapturedValue(pieces: PieceSymbol[]) {
  return pieces.reduce((total, piece) => total + PIECE_VALUES[piece], 0);
}

export function getMaterialAdvantage(capturedPieces: CapturedPieces) {
  return getCapturedValue(capturedPieces.byWhite) - getCapturedValue(capturedPieces.byBlack);
}

export function buildMoveRows(timeline: TimelineEntry[]): MoveRow[] {
  const moveRows: MoveRow[] = [];

  timeline.slice(1).forEach((entry) => {
    const moveNumber = entry.moveNumber ?? getMoveNumberForPly(entry.ply);
    let row = moveRows.find((candidate) => candidate.moveNumber === moveNumber);
    if (!row) {
      row = { moveNumber };
      moveRows.push(row);
    }
    if (entry.color === "w") {
      row.white = entry;
    } else if (entry.color === "b") {
      row.black = entry;
    }
  });

  if (timeline.length === 1) {
    return [];
  }

  return moveRows;
}

export function formatStartedAt(startedAt: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(startedAt);
}

export function formatEngineStatus(
  engineStatus: EngineStatus,
  isThinking: boolean,
  isReplyPending: boolean,
) {
  if (engineStatus === "failed") return "Failed";
  if (engineStatus === "loading") return "Loading";
  if (isThinking) return "Thinking";
  if (isReplyPending) return "Queued";
  return "Ready";
}

export function getEndReasonLabel(reason: GameEndReason | undefined) {
  if (reason === "checkmate") return "Checkmate";
  if (reason === "timeout") return "Timeout";
  if (reason === "resignation") return "Resignation";
  if (reason === "draw") return "Draw";
  return "In progress";
}

export function getSavedGameMoveCount(game: SavedGame) {
  return Array.isArray(game.timeline) ? Math.max(0, game.timeline.length - 1) : 0;
}

export function formatSavedGameDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function getPlayerOutcome(game: SavedGame) {
  if (game.result === "ongoing") return "Ongoing";
  if (game.result === "draw") return "Draw";
  const playerWinner = game.result === "white" ? "w" : "b";
  return playerWinner === getPlayerColor(game) ? "Win" : "Loss";
}

export function getSavedGameSummary(game: SavedGame) {
  const colorLabel = getPlayerColor(game) === "w" ? "White" : "Black";
  const timeControl = getTimeControlFromSavedGame(game).label;
  const depth = game.opponent_depth ?? DEFAULT_DEPTH;
  return `${colorLabel} | ${timeControl} | ${getEndReasonLabel(game.end_reason)} | Depth ${depth}`;
}
