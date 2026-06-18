import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import {
  Chessboard,
  defaultPieces,
  getRelativeCoords,
  type PieceRenderObject,
} from "react-chessboard";
import {
  playChessSound,
  unlockAudio,
  type ChessSoundEvent,
} from "./soundManager";
import { StockfishEngine } from "./stockfishEngine";
import "./App.css";

const DEFAULT_DEPTH = 10;
const STOCKFISH_REPLY_DELAY_MS = 1000;
const STOCKFISH_DRAG_RETRY_DELAY_MS = 150;
const TIMELINE_MOVE_ANIMATION_MS = 220;
const PIECE_VALUES: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};
const CAPTURED_PIECE_ORDER: PieceSymbol[] = ["q", "r", "b", "n", "p"];
const CAPTURED_PIECE_SYMBOLS: Record<"w" | "b", Record<PieceSymbol, string>> = {
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
type EngineStatus = "loading" | "ready" | "failed";
type ActiveSource = "click" | "drag";
type Premove = {
  from: Square;
  to: Square;
  promotion?: "q" | "r" | "b" | "n";
};
type TimelineEntry = {
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
type TimelineAnimation = {
  key: number;
  from: Square;
  to: Square;
  piece: string;
};
type MoveRow = {
  moveNumber: number;
  white?: TimelineEntry;
  black?: TimelineEntry;
};
type GameSnapshot = {
  fen: string;
  pgn: string;
};
type CapturedPieces = {
  byWhite: PieceSymbol[];
  byBlack: PieceSymbol[];
};

const SELECTED_SQUARE_STYLE: CSSProperties = {
  boxShadow: "inset 0 0 0 4px rgba(230, 170, 45, 0.95), inset 0 0 18px rgba(255, 220, 120, 0.85)",
};

const HOVERED_SQUARE_STYLE: CSSProperties = {
  boxShadow: "inset 0 0 0 3px rgba(255, 245, 190, 0.9), inset 0 0 16px rgba(255, 245, 190, 0.55)",
};

const PREMOVE_SOURCE_STYLE: CSSProperties = {
  boxShadow:
    "inset 0 0 0 4px rgba(118, 150, 255, 0.95), inset 0 0 18px rgba(118, 150, 255, 0.52)",
};

const PREMOVE_TARGET_STYLE: CSSProperties = {
  boxShadow:
    "inset 0 0 0 4px rgba(175, 104, 255, 0.9), inset 0 0 18px rgba(175, 104, 255, 0.48)",
};

const QUIET_MOVE_STYLE: CSSProperties = {
  backgroundImage:
    "radial-gradient(circle at center, rgba(40, 70, 55, 0.38) 0%, rgba(40, 70, 55, 0.38) 16%, transparent 17%)",
};

const CAPTURE_MOVE_STYLE: CSSProperties = {
  boxShadow: "inset 0 0 0 5px rgba(190, 70, 55, 0.68), inset 0 0 18px rgba(190, 70, 55, 0.35)",
};

const HIDDEN_DRAG_SOURCE_PIECE_STYLE: CSSProperties = {
  opacity: 1,
  visibility: "hidden",
};

const VISIBLE_DRAG_SOURCE_PIECE_STYLE: CSSProperties = {
  opacity: 1,
  visibility: "visible",
};

function isSquare(value: string | null): value is Square {
  return /^[a-h][1-8]$/.test(value ?? "");
}

function getSoundForMove(gameAfterMove: Chess, move: Move): ChessSoundEvent {
  if (gameAfterMove.isCheckmate()) return "checkmate";
  if (gameAfterMove.isCheck()) return "check";
  if (move.promotion) return "promote";
  if (move.captured) return "capture";
  return "move";
}

function getSoundForTimelineEntry(entry: TimelineEntry): ChessSoundEvent {
  const gameAfterMove = new Chess(entry.fen);

  if (gameAfterMove.isCheckmate()) return "checkmate";
  if (gameAfterMove.isCheck()) return "check";
  if (entry.promotion) return "promote";
  if (entry.san?.includes("x")) return "capture";
  return "move";
}

function cloneGameWithHistory(gameToClone: Chess) {
  const gameCopy = new Chess();
  const pgn = gameToClone.pgn();

  if (pgn) {
    gameCopy.loadPgn(pgn);
  }

  return gameCopy;
}

function getGameSnapshot(gameToSnapshot: Chess): GameSnapshot {
  return {
    fen: gameToSnapshot.fen(),
    pgn: gameToSnapshot.pgn(),
  };
}

function loadGameSnapshot(snapshot: GameSnapshot) {
  const gameCopy = new Chess();

  if (snapshot.pgn) {
    gameCopy.loadPgn(snapshot.pgn);
  } else {
    gameCopy.load(snapshot.fen);
  }

  return gameCopy;
}

function createInitialTimeline(): TimelineEntry[] {
  return [{ ply: 0, fen: new Chess().fen() }];
}

function getMoveNumberForPly(ply: number) {
  return Math.ceil(ply / 2);
}

function getRenderedPieceCode(fen: string, square: Square) {
  const piece = new Chess(fen).get(square);

  if (!piece) return null;

  return `${piece.color}${piece.type.toUpperCase()}`;
}

function sortCapturedPieces(pieces: PieceSymbol[]) {
  return [...pieces].sort(
    (a, b) => CAPTURED_PIECE_ORDER.indexOf(a) - CAPTURED_PIECE_ORDER.indexOf(b),
  );
}

function getCapturedPiecesFromTimeline(
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

function getCapturedValue(pieces: PieceSymbol[]) {
  return pieces.reduce((total, piece) => total + PIECE_VALUES[piece], 0);
}

function getMaterialAdvantage(capturedPieces: CapturedPieces) {
  return getCapturedValue(capturedPieces.byWhite) - getCapturedValue(capturedPieces.byBlack);
}

function buildMoveRows(timeline: TimelineEntry[]): MoveRow[] {
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

function formatStartedAt(startedAt: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(startedAt);
}

function MoveTable({
  rows,
  currentPlyIndex,
  onSelectMove,
}: {
  rows: MoveRow[];
  currentPlyIndex: number;
  onSelectMove: (entry: TimelineEntry) => void;
}) {
  function getMoveCellClass(entry?: TimelineEntry) {
    return entry?.ply === currentPlyIndex ? "current-move" : undefined;
  }

  function renderMoveButton(entry?: TimelineEntry) {
    if (!entry) return null;

    return (
      <button
        className="move-cell-button"
        type="button"
        onClick={() => onSelectMove(entry)}
      >
        {entry.san}
      </button>
    );
  }

  return (
    <div className="move-table-wrap">
      <table className="move-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">White</th>
            <th scope="col">Black</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.moveNumber}>
              <td>{row.moveNumber}.</td>
              <td className={getMoveCellClass(row.white)}>
                {renderMoveButton(row.white)}
              </td>
              <td className={getMoveCellClass(row.black)}>
                {renderMoveButton(row.black)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GameInfoPanel({
  startedAt,
  moveRows,
  currentPlyIndex,
  latestPly,
  onSelectMove,
  onFirstPly,
  onPreviousPly,
  onNextPly,
  onLastPly,
  onNewGame,
}: {
  startedAt: Date;
  moveRows: MoveRow[];
  currentPlyIndex: number;
  latestPly: number;
  onSelectMove: (entry: TimelineEntry) => void;
  onFirstPly: () => void;
  onPreviousPly: () => void;
  onNextPly: () => void;
  onLastPly: () => void;
  onNewGame: () => void;
}) {
  return (
    <aside className="game-panel" aria-label="Game information">
      <section className="game-details" aria-label="Game details">
        <dl>
          <div>
            <dt>Started</dt>
            <dd>{formatStartedAt(startedAt)}</dd>
          </div>
          <div>
            <dt>Info</dt>
            <dd>Standard vs Stockfish</dd>
          </div>
          <div>
            <dt>Time control</dt>
            <dd>10 min</dd>
          </div>
          <div>
            <dt>Position</dt>
            <dd>
              Ply {currentPlyIndex} / {latestPly}
            </dd>
          </div>
        </dl>

        <button className="new-game-button" type="button" onClick={onNewGame}>
          New Game
        </button>
      </section>

      <MoveTable
        rows={moveRows}
        currentPlyIndex={currentPlyIndex}
        onSelectMove={onSelectMove}
      />

      <div className="timeline-controls" aria-label="Timeline navigation">
        <button
          type="button"
          onClick={onFirstPly}
          disabled={currentPlyIndex === 0}
          aria-label="Starting position"
          title="Starting position"
        >
          &laquo;
        </button>
        <button
          type="button"
          onClick={onPreviousPly}
          disabled={currentPlyIndex === 0}
          aria-label="Previous position"
          title="Previous position"
        >
          &larr;
        </button>
        <button
          type="button"
          onClick={onNextPly}
          disabled={currentPlyIndex === latestPly}
          aria-label="Next position"
          title="Next position"
        >
          &rarr;
        </button>
        <button
          type="button"
          onClick={onLastPly}
          disabled={currentPlyIndex === latestPly}
          aria-label="Latest position"
          title="Latest position"
        >
          &raquo;
        </button>
      </div>
    </aside>
  );
}

function CapturedPiecesRow({
  capturedPieces,
  pieceColor,
  advantage,
  side,
}: {
  capturedPieces: PieceSymbol[];
  pieceColor: "w" | "b";
  advantage?: number;
  side: "top" | "bottom";
}) {
  const sortedPieces = sortCapturedPieces(capturedPieces);

  return (
    <div className={`captured-row captured-row-${side}`} aria-label={`${side} captured pieces`}>
      <div className="captured-pieces">
        {sortedPieces.map((piece, index) => (
          <span className="captured-piece" key={`${piece}-${index}`}>
            {CAPTURED_PIECE_SYMBOLS[pieceColor][piece]}
          </span>
        ))}
      </div>
      {advantage ? <span className="material-advantage">+{advantage}</span> : null}
    </div>
  );
}

export default function App() {
  const [game, setGame] = useState(new Chess());
  const [gameStartedAt, setGameStartedAt] = useState(() => new Date());
  const [timeline, setTimeline] = useState<TimelineEntry[]>(() => createInitialTimeline());
  const [currentPlyIndex, setCurrentPlyIndex] = useState(0);
  const [isThinking, setIsThinking] = useState(false);
  const [isStockfishReplyPending, setIsStockfishReplyPending] = useState(false);
  const [premove, setPremove] = useState<Premove | null>(null);
  const [depth] = useState(DEFAULT_DEPTH);
  const [, setEngineError] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("loading");
  const [activeSquare, setActiveSquare] = useState<Square | null>(null);
  const [activeSource, setActiveSource] = useState<ActiveSource | null>(null);
  const [hoveredSquare, setHoveredSquare] = useState<Square | null>(null);
  const [draggedSquare, setDraggedSquare] = useState<Square | null>(null);
  const [legalMoves, setLegalMoves] = useState<Move[]>([]);
  const [timelineAnimation, setTimelineAnimation] = useState<TimelineAnimation | null>(null);
  const [isBoardTeleporting, setIsBoardTeleporting] = useState(false);
  const [boardWidth, setBoardWidth] = useState(0);
  const gameRef = useRef(game);
  const timelineRef = useRef(timeline);
  const currentPlyIndexRef = useRef(currentPlyIndex);
  const engineRef = useRef<StockfishEngine | null>(null);
  const searchIdRef = useRef(0);
  const isThinkingRef = useRef(false);
  const isStockfishReplyPendingRef = useRef(false);
  const premoveRef = useRef<Premove | null>(null);
  const isDraggingRef = useRef(false);
  const isMoveBlockingDragRef = useRef(false);
  const draggedSquareRef = useRef<Square | null>(null);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const pendingStockfishTimeoutRef = useRef<number | null>(null);
  const timelineAnimationTimeoutRef = useRef<number | null>(null);
  const boardTeleportTimeoutRef = useRef<number | null>(null);
  const suppressClickAfterDragRef = useRef(false);
  const activeSquareRef = useRef<Square | null>(null);
  const activeSourceRef = useRef<ActiveSource | null>(null);
  const displayedFen = timeline[currentPlyIndex]?.fen ?? game.fen();
  const displayedGame = useMemo(() => new Chess(displayedFen), [displayedFen]);
  const isViewingLatest = currentPlyIndex === timeline.length - 1;
  const latestPly = timeline.length - 1;
  const timelinePieces = useMemo<PieceRenderObject>(() => {
    if (!timelineAnimation) {
      return defaultPieces;
    }

    return Object.fromEntries(
      Object.entries(defaultPieces).map(([pieceType, PieceSvg]) => [
        pieceType,
        (props?: Parameters<typeof PieceSvg>[0]) => {
          const shouldHideDestinationPiece =
            props?.square === timelineAnimation.to && pieceType === timelineAnimation.piece;

          return (
            <PieceSvg
              {...props}
              svgStyle={{
                ...props?.svgStyle,
                opacity: shouldHideDestinationPiece ? 0 : props?.svgStyle?.opacity,
              }}
            />
          );
        },
      ]),
    ) as PieceRenderObject;
  }, [timelineAnimation]);

  useEffect(() => {
    let isActive = true;
    const engine = new StockfishEngine();
    engineRef.current = engine;
    setEngineStatus("loading");
    setEngineError(null);

    void engine
      .ready()
      .then(() => {
        if (!isActive || engineRef.current !== engine) return;
        setEngineStatus("ready");
      })
      .catch((error) => {
        if (!isActive || engineRef.current !== engine) return;
        setEngineStatus("failed");
        setEngineError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      isActive = false;
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
      engine.quit();
    };
  }, []);

  useEffect(() => {
    if (!draggedSquare) return;

    function clearCanceledDrag(event: KeyboardEvent | PointerEvent | MouseEvent) {
      if ("key" in event && event.key !== "Escape") return;
      endDrag();
      clearInteractionState();
    }

    window.addEventListener("keydown", clearCanceledDrag);
    window.addEventListener("pointercancel", clearCanceledDrag);
    window.addEventListener("contextmenu", clearCanceledDrag);

    return () => {
      window.removeEventListener("keydown", clearCanceledDrag);
      window.removeEventListener("pointercancel", clearCanceledDrag);
      window.removeEventListener("contextmenu", clearCanceledDrag);
    };
  }, [draggedSquare]);

  useEffect(() => {
    if (!draggedSquare) return;
    if (!isSelectableHumanPiece(draggedSquare)) {
      endDrag();
    }
  }, [draggedSquare, engineStatus, isThinking, isStockfishReplyPending, displayedFen]);

  useEffect(() => {
    return () => {
      clearPendingStockfishDelay(false);
      clearTimelineAnimation(false);
      clearBoardTeleport(false);
    };
  }, []);

  useEffect(() => {
    const boardElement = boardWrapRef.current;
    if (!boardElement) return;

    const updateBoardWidth = () => {
      setBoardWidth(boardElement.getBoundingClientRect().width);
    };
    const resizeObserver = new ResizeObserver(updateBoardWidth);

    updateBoardWidth();
    resizeObserver.observe(boardElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  function setCurrentGame(nextGame: Chess) {
    gameRef.current = nextGame;
    setGame(nextGame);
  }

  function setTimelineEntries(nextTimeline: TimelineEntry[]) {
    timelineRef.current = nextTimeline;
    setTimeline(nextTimeline);
  }

  function setViewedPlyIndex(nextPlyIndex: number) {
    const boundedPlyIndex = Math.max(
      0,
      Math.min(nextPlyIndex, timelineRef.current.length - 1),
    );

    currentPlyIndexRef.current = boundedPlyIndex;
    setCurrentPlyIndex(boundedPlyIndex);
  }

  function setEngineThinking(nextIsThinking: boolean) {
    isThinkingRef.current = nextIsThinking;
    setIsThinking(nextIsThinking);
  }

  function setStockfishReplyPending(nextIsPending: boolean) {
    isStockfishReplyPendingRef.current = nextIsPending;
    setIsStockfishReplyPending(nextIsPending);
  }

  function setQueuedPremove(nextPremove: Premove | null) {
    premoveRef.current = nextPremove;
    setPremove(nextPremove);
  }

  function clearPendingStockfishDelay(shouldUpdateState = true) {
    if (pendingStockfishTimeoutRef.current === null) return;

    window.clearTimeout(pendingStockfishTimeoutRef.current);
    pendingStockfishTimeoutRef.current = null;

    if (shouldUpdateState) {
      setStockfishReplyPending(false);
    }
  }

  function clearTimelineAnimation(shouldUpdateState = true) {
    if (timelineAnimationTimeoutRef.current !== null) {
      window.clearTimeout(timelineAnimationTimeoutRef.current);
      timelineAnimationTimeoutRef.current = null;
    }

    if (shouldUpdateState) {
      setTimelineAnimation(null);
    }
  }

  function clearBoardTeleport(shouldUpdateState = true) {
    if (boardTeleportTimeoutRef.current !== null) {
      window.clearTimeout(boardTeleportTimeoutRef.current);
      boardTeleportTimeoutRef.current = null;
    }

    if (shouldUpdateState) {
      setIsBoardTeleporting(false);
    }
  }

  function teleportNextBoardRender() {
    clearBoardTeleport(false);
    setIsBoardTeleporting(true);

    boardTeleportTimeoutRef.current = window.setTimeout(() => {
      boardTeleportTimeoutRef.current = null;
      setIsBoardTeleporting(false);
    }, 0);
  }

  function startTimelineAnimation(entry: TimelineEntry) {
    if (!entry.from || !entry.to) return;

    const piece = getRenderedPieceCode(entry.fen, entry.to);
    if (!piece) return;

    clearTimelineAnimation(false);
    setTimelineAnimation({
      key: Date.now(),
      from: entry.from,
      to: entry.to,
      piece,
    });

    timelineAnimationTimeoutRef.current = window.setTimeout(() => {
      timelineAnimationTimeoutRef.current = null;
      setTimelineAnimation(null);
    }, TIMELINE_MOVE_ANIMATION_MS);
  }

  function appendTimelineMove(gameAfterMove: Chess, move: Move) {
    const previousTimeline = timelineRef.current;
    const wasViewingLatest = currentPlyIndexRef.current === previousTimeline.length - 1;
    const nextPly = previousTimeline.length;
    const nextEntry: TimelineEntry = {
      ply: nextPly,
      fen: gameAfterMove.fen(),
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      moveNumber: getMoveNumberForPly(nextPly),
      color: move.color,
      captured: move.captured,
    };

    setTimelineEntries([...previousTimeline, nextEntry]);

    if (wasViewingLatest) {
      setViewedPlyIndex(nextPly);
    }
  }

  function scheduleStockfishReply(gameBeforeStockfishMove: Chess) {
    scheduleStockfishSnapshot(getGameSnapshot(gameBeforeStockfishMove), STOCKFISH_REPLY_DELAY_MS);
  }

  function scheduleStockfishSnapshot(snapshot: GameSnapshot, delayMs: number) {
    clearPendingStockfishDelay();
    setStockfishReplyPending(true);

    pendingStockfishTimeoutRef.current = window.setTimeout(() => {
      pendingStockfishTimeoutRef.current = null;
      setStockfishReplyPending(false);
      void makeStockfishMove(snapshot);
    }, delayMs);
  }

  async function makeStockfishMove(snapshot: GameSnapshot) {
    const engine = engineRef.current;
    if (!engine) {
      setEngineStatus("failed");
      setEngineError("Stockfish engine has not been created yet.");
      return;
    }

    let deferredForActiveDrag = false;
    let shouldPreserveVisualDrag = false;
    const searchId = searchIdRef.current + 1;
    searchIdRef.current = searchId;
    setEngineThinking(true);
    setEngineError(null);

    try {
      const bestMove = await engine.findBestMove(snapshot.fen, depth);

      if (searchId !== searchIdRef.current) return;

      if (isMoveBlockingDragRef.current) {
        deferredForActiveDrag = true;
        scheduleStockfishSnapshot(snapshot, STOCKFISH_DRAG_RETRY_DELAY_MS);
        return;
      }

      shouldPreserveVisualDrag = isDraggingRef.current;

      const gameCopy = loadGameSnapshot(snapshot);
      const move = gameCopy.move({
        from: bestMove.slice(0, 2),
        to: bestMove.slice(2, 4),
        promotion: bestMove[4] ?? "q",
      });

      if (move) {
        setCurrentGame(gameCopy);
        appendTimelineMove(gameCopy, move);
        playChessSound(getSoundForMove(gameCopy, move));
      }

      const didApplyPremove = move ? applyQueuedPremove(gameCopy) : false;

      if (!didApplyPremove) {
        refreshInteractionStateForGame(gameCopy, {
          preserveDrag: shouldPreserveVisualDrag,
        });
      }
    } catch (error) {
      if (searchId === searchIdRef.current) {
        const message = error instanceof Error ? error.message : String(error);
        setEngineError(`Stockfish search failed: ${message}`);

        if (!engine.isReady()) {
          setEngineStatus("failed");
        }
      }
    } finally {
      if (searchId === searchIdRef.current) {
        setEngineThinking(false);
      }

      if (!deferredForActiveDrag && !shouldPreserveVisualDrag) {
        endDrag();
      }
    }
  }

  function isStockfishThinking() {
    return isThinkingRef.current || isStockfishReplyPendingRef.current;
  }

  function canSelectWhitePieces() {
    return !displayedGame.isGameOver();
  }

  function canMoveWhitePieces() {
    const currentGame = gameRef.current;

    return (
      currentGame.turn() === "w" &&
      currentPlyIndexRef.current === timelineRef.current.length - 1 &&
      !isStockfishThinking() &&
      !currentGame.isGameOver()
    );
  }

  function canSetPremove() {
    const currentGame = gameRef.current;

    return (
      currentPlyIndexRef.current === timelineRef.current.length - 1 &&
      !currentGame.isGameOver() &&
      (currentGame.turn() !== "w" || isStockfishThinking())
    );
  }

  function canQueuePremove(sourceSquare: Square, targetSquare: Square) {
    if (!canSetPremove() || sourceSquare === targetSquare) {
      return false;
    }

    const sourcePiece = displayedGame.get(sourceSquare);
    const targetPiece = displayedGame.get(targetSquare);

    return sourcePiece?.color === "w" && targetPiece?.color !== "w";
  }

  function getLegalMovesForSquare(square: Square, sourceGame = gameRef.current) {
    const piece = sourceGame.get(square);

    if (!piece) {
      return [];
    }

    if (sourceGame.turn() === piece.color) {
      return sourceGame.moves({ square, verbose: true });
    }

    const fenParts = sourceGame.fen().split(" ");
    fenParts[1] = piece.color;
    fenParts[3] = "-";

    try {
      const previewGame = new Chess(fenParts.join(" "));
      return previewGame.moves({ square, verbose: true });
    } catch {
      return [];
    }
  }

  function isSelectableHumanPiece(square: Square) {
    const piece = displayedGame.get(square);
    return canSelectWhitePieces() && piece?.color === "w";
  }

  function setSelectedSquare(square: Square | null) {
    activeSquareRef.current = square;
    setActiveSquare(square);
  }

  function setSelectedSource(source: ActiveSource | null) {
    activeSourceRef.current = source;
    setActiveSource(source);
  }

  function clearInteractionState({
    preserveDrag = false,
    preserveLegalMoves = false,
  } = {}) {
    setSelectedSquare(null);
    setSelectedSource(null);
    setHoveredSquare(null);
    if (!preserveDrag) {
      endDrag();
    }

    if (preserveLegalMoves && draggedSquareRef.current) {
      setLegalMoves(getLegalMovesForSquare(draggedSquareRef.current, displayedGame));
    } else {
      setLegalMoves([]);
    }
  }

  function queuePremove(sourceSquare: Square, targetSquare: Square) {
    if (!canQueuePremove(sourceSquare, targetSquare)) {
      return false;
    }

    setQueuedPremove({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });
    clearInteractionState();
    return true;
  }

  function applyQueuedPremove(gameAfterStockfishMove: Chess) {
    const queuedPremove = premoveRef.current;

    if (!queuedPremove) {
      return false;
    }

    setQueuedPremove(null);
    const gameCopy = cloneGameWithHistory(gameAfterStockfishMove);
    const move = gameCopy.move(queuedPremove);

    if (!move) {
      return false;
    }

    clearInteractionState();
    setCurrentGame(gameCopy);
    appendTimelineMove(gameCopy, move);
    playChessSound(getSoundForMove(gameCopy, move));

    if (!gameCopy.isGameOver()) {
      scheduleStockfishReply(gameCopy);
    }

    return true;
  }

  function refreshInteractionStateForGame(
    sourceGame: Chess,
    { preserveDrag = false } = {},
  ) {
    const selectedSquare = activeSquareRef.current;
    const selectedSource = activeSourceRef.current;

    setHoveredSquare(null);

    if (!preserveDrag) {
      endDrag();
    }

    if (!selectedSquare || !selectedSource) {
      setLegalMoves([]);
      return;
    }

    const selectedPiece = sourceGame.get(selectedSquare);

    if (selectedPiece?.color !== "w") {
      setSelectedSquare(null);
      setSelectedSource(null);
      setLegalMoves([]);
      return;
    }

    setLegalMoves(getLegalMovesForSquare(selectedSquare, sourceGame));
  }

  function beginDrag(square: Square, shouldBlockStockfish: boolean) {
    isDraggingRef.current = true;
    isMoveBlockingDragRef.current = shouldBlockStockfish;
    draggedSquareRef.current = square;
    setDraggedSquare(square);
  }

  function endDrag() {
    isDraggingRef.current = false;
    isMoveBlockingDragRef.current = false;
    draggedSquareRef.current = null;
    setDraggedSquare(null);
  }

  function suppressFollowUpClickAfterDrag() {
    suppressClickAfterDragRef.current = true;

    window.setTimeout(() => {
      suppressClickAfterDragRef.current = false;
    }, 100);
  }

  function activateSquare(square: Square, source: ActiveSource) {
    if (!isSelectableHumanPiece(square)) {
      clearInteractionState();
      return false;
    }

    const moves = getLegalMovesForSquare(square, displayedGame);

    setSelectedSquare(square);
    setSelectedSource(source);
    setHoveredSquare(null);
    setLegalMoves(moves);
    return true;
  }

  function makeMove(sourceSquare: Square, targetSquare: Square) {
    if (!canMoveWhitePieces()) {
      return false;
    }

    const gameCopy = cloneGameWithHistory(gameRef.current);

    const move = gameCopy.move({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });

    if (move === null) {
      endDrag();
      return false;
    }

    unlockAudio();
    setQueuedPremove(null);
    clearInteractionState();
    setCurrentGame(gameCopy);
    appendTimelineMove(gameCopy, move);
    playChessSound(getSoundForMove(gameCopy, move));

    if (!gameCopy.isGameOver()) {
      scheduleStockfishReply(gameCopy);
    }

    return true;
  }

  function handleSquareClick(square: Square) {
    if (suppressClickAfterDragRef.current) {
      suppressClickAfterDragRef.current = false;
      return;
    }

    unlockAudio();

    if (canSetPremove() && premove?.from === square) {
      setQueuedPremove(null);
      clearInteractionState();
      return;
    }

    if (square === activeSquare) {
      clearInteractionState();
      return;
    }

    if (activeSquare && canSetPremove() && queuePremove(activeSquare, square)) {
      return;
    }

    if (activeSquare && legalMoves.some((move) => move.to === square)) {
      if (canMoveWhitePieces()) {
        void makeMove(activeSquare, square);
      }

      return;
    }

    if (isSelectableHumanPiece(square)) {
      if (canSetPremove()) {
        setQueuedPremove(null);
      }
      activateSquare(square, "click");
      return;
    }

    clearInteractionState();
  }

  function handlePieceDrag(square: string | null) {
    suppressFollowUpClickAfterDrag();
    unlockAudio();

    if (!isSquare(square)) {
      endDrag();
      clearInteractionState();
      return;
    }

    if (isViewingLatest && isSelectableHumanPiece(square)) {
      if (canSetPremove()) {
        setQueuedPremove(null);
      }
      beginDrag(square, canMoveWhitePieces());
      activateSquare(square, "drag");
      return;
    }

    endDrag();
    clearInteractionState();
  }

  function handlePieceDrop(sourceSquare: string, targetSquare: string | null) {
    try {
      if (
        !isSquare(sourceSquare) ||
        !isSquare(targetSquare) ||
        sourceSquare === targetSquare
      ) {
        endDrag();
        clearInteractionState();
        return false;
      }

      const didMove = makeMove(sourceSquare, targetSquare);

      if (!didMove && queuePremove(sourceSquare, targetSquare)) {
        return true;
      }

      if (!didMove) {
        clearInteractionState();
      }

      return didMove;
    } finally {
      endDrag();
      suppressFollowUpClickAfterDrag();
    }
  }

  function handleMouseOverSquare(square: Square) {
    if (!activeSquare && !draggedSquare && isSelectableHumanPiece(square)) {
      setHoveredSquare(square);
    }
  }

  function handleMouseOutSquare() {
    setHoveredSquare(null);
  }

  function playTimelineSoundForPly(ply: number) {
    const targetEntry = timelineRef.current[ply];

    if (!targetEntry?.san) return;

    unlockAudio();
    playChessSound(getSoundForTimelineEntry(targetEntry));
  }

  function goToPly(ply: number, { playSound = true } = {}) {
    clearTimelineAnimation();
    clearInteractionState();
    setViewedPlyIndex(ply);

    if (ply !== timelineRef.current.length - 1) {
      setQueuedPremove(null);
    }

    if (playSound) {
      playTimelineSoundForPly(ply);
    }
  }

  function selectTimelineMove(entry: TimelineEntry) {
    clearInteractionState();
    if (entry.ply !== timelineRef.current.length - 1) {
      setQueuedPremove(null);
    }
    setViewedPlyIndex(entry.ply);
    playTimelineSoundForPly(entry.ply);
    startTimelineAnimation(entry);
  }

  function goToPreviousPly() {
    goToPly(currentPlyIndexRef.current - 1);
  }

  function goToNextPly() {
    goToPly(currentPlyIndexRef.current + 1);
  }

  function goToFirstPly() {
    goToPly(0);
  }

  function goToLastPly() {
    goToPly(timelineRef.current.length - 1);
  }

  function startNewGame() {
    clearPendingStockfishDelay();
    clearTimelineAnimation();
    teleportNextBoardRender();
    searchIdRef.current += 1;
    setEngineThinking(false);
    setStockfishReplyPending(false);
    setQueuedPremove(null);
    clearInteractionState();

    const freshGame = new Chess();
    const freshTimeline = createInitialTimeline();

    setCurrentGame(freshGame);
    setTimelineEntries(freshTimeline);
    setViewedPlyIndex(0);
    setGameStartedAt(new Date());
    setEngineError(null);
  }

  function buildCustomSquareStyles(): Record<string, CSSProperties> {
    const squareStyles: Record<string, CSSProperties> = {};

    if (hoveredSquare && hoveredSquare !== activeSquare) {
      squareStyles[hoveredSquare] = HOVERED_SQUARE_STYLE;
    }

    if (activeSquare && activeSource) {
      squareStyles[activeSquare] = SELECTED_SQUARE_STYLE;
    }

    if (isViewingLatest && premove) {
      squareStyles[premove.from] = {
        ...squareStyles[premove.from],
        ...PREMOVE_SOURCE_STYLE,
      };
      squareStyles[premove.to] = {
        ...squareStyles[premove.to],
        ...PREMOVE_TARGET_STYLE,
      };
    }

    legalMoves.forEach((move) => {
      squareStyles[move.to] = {
        ...squareStyles[move.to],
        ...(move.isCapture() ? CAPTURE_MOVE_STYLE : QUIET_MOVE_STYLE),
      };
    });

    return squareStyles;
  }

  const moveRows = buildMoveRows(timeline);
  const capturedPieces = getCapturedPiecesFromTimeline(timeline, currentPlyIndex);
  const materialAdvantage = getMaterialAdvantage(capturedPieces);
  const whiteMaterialAdvantage = materialAdvantage > 0 ? materialAdvantage : undefined;
  const blackMaterialAdvantage = materialAdvantage < 0 ? Math.abs(materialAdvantage) : undefined;
  const animatedPiece = timelineAnimation
    ? defaultPieces[timelineAnimation.piece]
    : null;
  const timelineAnimationStyle = getTimelineAnimationStyle(
    timelineAnimation,
    boardWidth,
  );

  return (
    <main className="app-shell">
      <h1>Chess vs Stockfish</h1>

      <div className="game-layout">
        <div className="board-column">
          <CapturedPiecesRow
            capturedPieces={capturedPieces.byBlack}
            pieceColor="w"
            advantage={blackMaterialAdvantage}
            side="top"
          />
          <div className="board-wrap" ref={boardWrapRef}>
            <Chessboard
              options={{
                position: displayedFen,
                pieces: timelinePieces,
                squareStyles: buildCustomSquareStyles(),
                showAnimations: !timelineAnimation && !isBoardTeleporting,
                animationDurationInMs: TIMELINE_MOVE_ANIMATION_MS,
                allowDragging: isViewingLatest && canSelectWhitePieces(),
                canDragPiece: ({ piece, square }) =>
                  isViewingLatest &&
                  piece.pieceType.startsWith("w") &&
                  isSquare(square) &&
                  isSelectableHumanPiece(square),
                draggingPieceGhostStyle: draggedSquare && isDraggingRef.current
                  ? HIDDEN_DRAG_SOURCE_PIECE_STYLE
                  : VISIBLE_DRAG_SOURCE_PIECE_STYLE,
                onPieceDrag: ({ square }) => handlePieceDrag(square),
                onPieceDrop: ({ sourceSquare, targetSquare }) =>
                  handlePieceDrop(sourceSquare, targetSquare),
                onSquareClick: ({ square }) => {
                  if (isSquare(square)) {
                    handleSquareClick(square);
                  }
                },
                onMouseOverSquare: ({ square }) => {
                  if (isSquare(square)) {
                    handleMouseOverSquare(square);
                  }
                },
                onMouseOutSquare: () => handleMouseOutSquare(),
              }}
            />

            {timelineAnimation && animatedPiece && timelineAnimationStyle ? (
              <div
                className="timeline-piece-animation"
                key={timelineAnimation.key}
                style={timelineAnimationStyle}
                aria-hidden="true"
              >
                {animatedPiece({ square: timelineAnimation.to })}
              </div>
            ) : null}
          </div>
          <CapturedPiecesRow
            capturedPieces={capturedPieces.byWhite}
            pieceColor="b"
            advantage={whiteMaterialAdvantage}
            side="bottom"
          />
        </div>

        <GameInfoPanel
          startedAt={gameStartedAt}
          moveRows={moveRows}
          currentPlyIndex={currentPlyIndex}
          latestPly={latestPly}
          onSelectMove={selectTimelineMove}
          onFirstPly={goToFirstPly}
          onPreviousPly={goToPreviousPly}
          onNextPly={goToNextPly}
          onLastPly={goToLastPly}
          onNewGame={startNewGame}
        />
      </div>
    </main>
  );
}

function getTimelineAnimationStyle(
  animation: TimelineAnimation | null,
  boardWidth: number,
): CSSProperties | undefined {
  if (!animation || boardWidth <= 0) return undefined;

  const squareSize = boardWidth / 8;
  const from = getRelativeCoords("white", boardWidth, 8, 8, animation.from);
  const to = getRelativeCoords("white", boardWidth, 8, 8, animation.to);

  return {
    "--timeline-animation-duration": `${TIMELINE_MOVE_ANIMATION_MS}ms`,
    "--timeline-from-x": `${from.x - squareSize / 2}px`,
    "--timeline-from-y": `${from.y - squareSize / 2}px`,
    "--timeline-to-x": `${to.x - squareSize / 2}px`,
    "--timeline-to-y": `${to.y - squareSize / 2}px`,
    height: `${squareSize}px`,
    width: `${squareSize}px`,
  } as CSSProperties;
}
