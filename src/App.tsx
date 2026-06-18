import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import type { Session, User } from "@supabase/supabase-js";
import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import {
  Chessboard,
  defaultPieces,
  getRelativeCoords,
  type Arrow,
  type PieceRenderObject,
} from "react-chessboard";
import {
  playChessSound,
  unlockAudio,
} from "./soundManager";
import { StockfishEngine } from "./stockfishEngine";
import { EvaluationBar } from "./components/EvaluationBar";
import { useEvaluation } from "./hooks/useEvaluation";
import {
  isSupabaseConfigured,
  supabase,
  type GameEndReason,
  type GameResult,
  type PlayerColor,
  type SavedGame,
} from "./lib/supabase";
import {
  DEFAULT_DEPTH,
  DEFAULT_EVALUATION_DEPTH,
  MIN_OPPONENT_DEPTH,
  MAX_OPPONENT_DEPTH,
  STOCKFISH_REPLY_DELAY_MS,
  STOCKFISH_DRAG_RETRY_DELAY_MS,
  TIMELINE_MOVE_ANIMATION_MS,
  CLOCK_PERSIST_INTERVAL_MS,
  DEFAULT_PLAYER_COLOR,
  CAPTURED_PIECE_SYMBOLS,
  TIME_CONTROL_OPTIONS,
  DEFAULT_TIME_CONTROL,
  getApproxEloForDepth,
} from "./constants";
import type {
  EngineStatus,
  ActiveSource,
  Premove,
  TimelineEntry,
  TimelineAnimation,
  MoveRow,
  GameSnapshot,
  GameScreenMode,
  SavedGameCompletion,
  AnalysisSandbox,
  AnalysisMove,
} from "./types/game";
import {
  isSquare,
  getSoundForMove,
  getSoundForTimelineEntry,
  cloneGameWithHistory,
  getGameSnapshot,
  loadGameSnapshot,
  parseSavedTimeline,
  createInitialTimeline,
  getSavedGameStatus,
  getOpponentResult,
  getPlayerColor,
  getTimeControlFromSavedGame,
  getInitialRemainingSeconds,
  isTimedGame,
  formatClock,
  getTimeControlDescription,
  getMoveNumberForPly,
  getRenderedPieceCode,
  sortCapturedPieces,
  getCapturedPiecesFromTimeline,
  getMaterialAdvantage,
  buildMoveRows,
  formatStartedAt,
  formatEngineStatus,
  getEndReasonLabel,
  getSavedGameMoveCount,
  formatSavedGameDate,
  getPlayerOutcome,
  getSavedGameSummary,
} from "./utils/chessUtils";
import "./App.css";


type AuthContextValue = {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
};

const AuthContext = createContext<AuthContextValue>({
  session: null,
  user: null,
  isLoading: true,
});


function useAuth() {
  return useContext(AuthContext);
}

function requireSupabase() {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  return supabase;
}

async function ensureUserRows(user: User) {
  const client = requireSupabase();
  const email = user.email ?? "unknown@example.com";

  await client.from("profiles").upsert({
    id: user.id,
    email,
    display_name: email.split("@")[0] ?? email,
    updated_at: new Date().toISOString(),
  });

  await client.from("preferences").upsert({
    user_id: user.id,
    sound_enabled: true,
    default_opponent_depth: DEFAULT_DEPTH,
    default_eval_depth: DEFAULT_EVALUATION_DEPTH,
  });
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let isActive = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (!isActive) return;
      setSession(data.session);
      setIsLoading(false);
      if (data.session?.user) {
        void ensureUserRows(data.session.user);
      }
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) {
        void ensureUserRows(nextSession.user);
      }
    });

    return () => {
      isActive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      isLoading,
    }),
    [session, isLoading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

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
  playerColor,
  timeControlLabel,
  playerTimeRemainingSeconds,
  endReason,
  isGameCompleted,
  canResign,
  moveRows,
  currentPlyIndex,
  latestPly,
  onSelectMove,
  onFirstPly,
  onPreviousPly,
  onNextPly,
  onLastPly,
  onNewGame,
  onResign,
  engineStatus,
  engineError,
  isThinking,
  isReplyPending,
  opponentDepth,
  isAnalysisActive,
  analysisMoveCount,
  onResetAnalysis,
}: {
  startedAt: Date;
  playerColor: PlayerColor;
  timeControlLabel: string;
  playerTimeRemainingSeconds: number | null;
  endReason: GameEndReason;
  isGameCompleted: boolean;
  canResign: boolean;
  moveRows: MoveRow[];
  currentPlyIndex: number;
  latestPly: number;
  onSelectMove: (entry: TimelineEntry) => void;
  onFirstPly: () => void;
  onPreviousPly: () => void;
  onNextPly: () => void;
  onLastPly: () => void;
  onNewGame: () => void;
  onResign: () => void;
  engineStatus: EngineStatus;
  engineError: string | null;
  isThinking: boolean;
  isReplyPending: boolean;
  opponentDepth: number;
  isAnalysisActive: boolean;
  analysisMoveCount: number;
  onResetAnalysis: () => void;
}) {
  const formattedEngineStatus = formatEngineStatus(
    engineStatus,
    isThinking,
    isReplyPending,
  );

  return (
    <aside className="game-panel" aria-label="Game information">
      <section className="game-details" aria-label="Game details">
        <dl>
          <div>
            <dt>Started</dt>
            <dd>{formatStartedAt(startedAt)}</dd>
          </div>
          <div>
            <dt>Side</dt>
            <dd>{playerColor === "w" ? "White" : "Black"} vs Stockfish</dd>
          </div>
          <div>
            <dt>Time control</dt>
            <dd>{timeControlLabel}</dd>
          </div>
          <div>
            <dt>Clock</dt>
            <dd>{formatClock(playerTimeRemainingSeconds)}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{isGameCompleted ? getEndReasonLabel(endReason) : "Active"}</dd>
          </div>
          <div>
            <dt>Depth</dt>
            <dd>
              {opponentDepth} <span className="elo-hint">(~{getApproxEloForDepth(opponentDepth)} Elo)</span>
            </dd>
          </div>
          <div>
            <dt>Position</dt>
            <dd>
              Ply {currentPlyIndex} / {latestPly}
            </dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd className={`engine-status engine-status-${engineStatus}`}>
              {formattedEngineStatus}
            </dd>
          </div>
        </dl>

        {engineError ? (
          <p className="engine-alert" role="alert">
            {engineError}
          </p>
        ) : null}

        <button className="new-game-button" type="button" onClick={onNewGame}>
          New Game
        </button>
        {canResign ? (
          <button className="resign-button" type="button" onClick={onResign}>
            Resign
          </button>
        ) : null}
      </section>

      {isAnalysisActive ? (
        <div className="analysis-banner" role="status">
          <span>
            Analysis line
            {analysisMoveCount > 0 ? ` · ${analysisMoveCount} move${analysisMoveCount !== 1 ? "s" : ""}` : ""}
          </span>
          <button
            className="reset-analysis-button"
            type="button"
            onClick={onResetAnalysis}
          >
            Reset
          </button>
        </div>
      ) : null}

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

function SetupScreen() {
  return (
    <main className="prototype-shell">
      <section className="auth-panel">
        <h1>Chess Prototype Setup</h1>
        <p>
          Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to your local
          environment, then run the SQL in `supabase/schema.sql`.
        </p>
        <p className="muted-copy">
          The board and client-side engines are ready, but account-backed games
          need Supabase before the hub can load.
        </p>
      </section>
    </main>
  );
}

function LoadingScreen() {
  return (
    <main className="prototype-shell">
      <div className="loading-panel">Loading prototype</div>
    </main>
  );
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();

  if (!isSupabaseConfigured) return <SetupScreen />;
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Navigate to="/auth" replace />;

  return children;
}

function AuthScreen() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && user) {
      navigate("/", { replace: true });
    }
  }, [isLoading, navigate, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = requireSupabase();

    setIsSubmitting(true);
    setMessage(null);

    const authResponse =
      mode === "login"
        ? await client.auth.signInWithPassword({ email, password })
        : await client.auth.signUp({ email, password });

    setIsSubmitting(false);

    if (authResponse.error) {
      setMessage(authResponse.error.message);
      return;
    }

    if (authResponse.data.user && authResponse.data.session) {
      await ensureUserRows(authResponse.data.user);
    }

    if (mode === "signup" && !authResponse.data.session) {
      setMessage("Check your email to confirm your account, then sign in.");
      return;
    }

    navigate("/", { replace: true });
  }

  if (!isSupabaseConfigured) return <SetupScreen />;

  return (
    <main className="prototype-shell">
      <form className="auth-panel" onSubmit={handleSubmit}>
        <h1>{mode === "login" ? "Sign in" : "Create account"}</h1>
        <label>
          Email
          <input
            autoComplete="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={6}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {message ? <p className="form-message">{message}</p> : null}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Working" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
        >
          {mode === "login" ? "Create an account" : "I already have an account"}
        </button>
      </form>
    </main>
  );
}

function HubScreen() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState<SavedGame[]>([]);
  const [isLoadingGames, setIsLoadingGames] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeGames = games.filter((game) => game.status === "active");
  const latestActiveGame = activeGames[0];
  const wins = games.filter((game) => getPlayerOutcome(game) === "Win").length;
  const losses = games.filter((game) => getPlayerOutcome(game) === "Loss").length;
  const draws = games.filter((game) => game.result === "draw").length;

  useEffect(() => {
    if (!user) return;
    const client = requireSupabase();

    void client
      .from("games")
      .select("*")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(20)
      .then(({ data, error: loadError }) => {
        if (loadError) {
          setError(loadError.message);
        } else {
          setGames((data ?? []) as SavedGame[]);
        }
        setIsLoadingGames(false);
      });
  }, [user]);

  function handleNewGame() {
    navigate("/play/new");
  }

  return (
    <main className="hub-shell">
      <header className="hub-header">
        <div>
          <p className="eyebrow">Prototype hub</p>
          <h1>Welcome back, {user?.email?.split("@")[0] ?? "player"}</h1>
        </div>
        <nav className="hub-nav" aria-label="Hub navigation">
          <Link to="/settings">Settings</Link>
          <button
            type="button"
            onClick={() => {
              void requireSupabase().auth.signOut();
            }}
          >
            Sign out
          </button>
        </nav>
      </header>

      {error ? <p className="hub-error">{error}</p> : null}

      <section className="hub-actions" aria-label="Primary actions">
        <button type="button" onClick={handleNewGame}>
          New Game
        </button>
        <button
          type="button"
          disabled={!latestActiveGame}
          onClick={() => latestActiveGame && navigate(`/play/${latestActiveGame.id}`)}
        >
          Resume Game
        </button>
        <button
          type="button"
          disabled={games.length === 0}
          onClick={() => navigate("/history")}
        >
          Game History
        </button>
      </section>

      <section className="stats-grid" aria-label="Game statistics">
        <div>
          <span>{games.length}</span>
          <p>Games</p>
        </div>
        <div>
          <span>{wins}</span>
          <p>Wins</p>
        </div>
        <div>
          <span>{losses}</span>
          <p>Losses</p>
        </div>
        <div>
          <span>{draws}</span>
          <p>Draws</p>
        </div>
        <div>
          <span>{activeGames.length}</span>
          <p>Active</p>
        </div>
      </section>

      <section className="mode-grid" aria-label="Modes">
        <button className="mode-card" type="button" onClick={handleNewGame}>
          <strong>Play vs Stockfish</strong>
          <span>Start a saved account-backed game.</span>
        </button>
        <button
          className="mode-card"
          type="button"
          disabled={games.length === 0}
          onClick={() => navigate("/history")}
        >
          <strong>Game History</strong>
          <span>Resume or review your saved games with the client-side Eval Bar.</span>
        </button>
        <div className="mode-card mode-card-disabled">
          <strong>Opening Trainer</strong>
          <span>Coming soon: scripted opening lines and repertoire practice.</span>
        </div>
        <div className="mode-card mode-card-disabled">
          <strong>Practice Library</strong>
          <span>Coming soon: saved studies, drills, and progress tracking.</span>
        </div>
      </section>

      <section className="recent-games" aria-label="Recent games">
        <h2>Recent games</h2>
        {isLoadingGames ? <p className="muted-copy">Loading games</p> : null}
        {!isLoadingGames && games.length === 0 ? (
          <p className="muted-copy">No games yet. Start a new game to create your first save.</p>
        ) : null}
        <div className="game-list">
          {games.map((game) => (
            <article className="saved-game-row" key={game.id}>
              <div>
                <strong>{getPlayerOutcome(game)}</strong>
                <span>
                  {getSavedGameMoveCount(game)} plies | {getSavedGameSummary(game)} | {formatSavedGameDate(game.updated_at)}
                </span>
              </div>
              <div className="saved-game-actions">
                {game.status === "active" ? <Link to={`/play/${game.id}`}>Resume</Link> : null}
                <Link to={`/review/${game.id}`}>Review</Link>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function HistoryScreen() {
  const { user } = useAuth();
  const [games, setGames] = useState<SavedGame[]>([]);
  const [isLoadingGames, setIsLoadingGames] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const client = requireSupabase();

    void client
      .from("games")
      .select("*")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .then(({ data, error: loadError }) => {
        if (loadError) {
          setError(loadError.message);
        } else {
          setGames((data ?? []) as SavedGame[]);
        }
        setIsLoadingGames(false);
      });
  }, [user]);

  return (
    <main className="hub-shell">
      <header className="hub-header">
        <div>
          <p className="eyebrow">Saved games</p>
          <h1>Game History</h1>
        </div>
        <nav className="hub-nav" aria-label="History navigation">
          <Link to="/">Hub</Link>
          <Link to="/play/new">New Game</Link>
        </nav>
      </header>

      {error ? <p className="hub-error">{error}</p> : null}

      <section className="recent-games" aria-label="Game history">
        {isLoadingGames ? <p className="muted-copy">Loading games</p> : null}
        {!isLoadingGames && games.length === 0 ? (
          <p className="muted-copy">No saved games yet. Start a new game to build your history.</p>
        ) : null}
        <div className="game-list">
          {games.map((game) => (
            <article className="saved-game-row" key={game.id}>
              <div>
                <strong>{getPlayerOutcome(game)}</strong>
                <span>
                  {getSavedGameMoveCount(game)} plies | {getSavedGameSummary(game)} | {formatSavedGameDate(game.updated_at)}
                </span>
              </div>
              <div className="saved-game-actions">
                {game.status === "active" ? <Link to={`/play/${game.id}`}>Resume</Link> : null}
                <Link to={`/review/${game.id}`}>Review</Link>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function SettingsScreen() {
  const { user } = useAuth();

  return (
    <main className="hub-shell">
      <header className="hub-header">
        <div>
          <p className="eyebrow">Account</p>
          <h1>Settings</h1>
        </div>
        <nav className="hub-nav" aria-label="Settings navigation">
          <Link to="/">Hub</Link>
          <button
            type="button"
            onClick={() => {
              void requireSupabase().auth.signOut();
            }}
          >
            Sign out
          </button>
        </nav>
      </header>
      <section className="settings-panel">
        <dl>
          <div>
            <dt>Email</dt>
            <dd>{user?.email}</dd>
          </div>
          <div>
            <dt>Opponent depth</dt>
            <dd>{DEFAULT_DEPTH}</dd>
          </div>
          <div>
            <dt>Evaluation depth</dt>
            <dd>{DEFAULT_EVALUATION_DEPTH}</dd>
          </div>
        </dl>
        <p className="muted-copy">
          Preference editing is intentionally small in v1; the saved rows are
          created so settings can grow without changing the account model.
        </p>
      </section>
    </main>
  );
}

function PlayRoute() {
  const { gameId } = useParams();
  if (!gameId) return <Navigate to="/" replace />;

  return <ChessGameScreen mode="play" gameId={gameId} />;
}

function ReviewRoute() {
  const { gameId } = useParams();
  if (!gameId) return <Navigate to="/" replace />;

  return <ChessGameScreen mode="review" gameId={gameId} />;
}

function NewGameRoute() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [playerColor, setPlayerColor] = useState<PlayerColor>(DEFAULT_PLAYER_COLOR);
  const [selectedTimeControl, setSelectedTimeControl] = useState(DEFAULT_TIME_CONTROL);
  const [selectedDepth, setSelectedDepth] = useState(DEFAULT_DEPTH);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  async function startConfiguredGame() {
    if (!user) return;
    const client = requireSupabase();
    const startedAt = new Date().toISOString();
    const initialRemainingSeconds = getInitialRemainingSeconds(selectedTimeControl);

    setIsCreating(true);
    setError(null);

    const { data, error: createError } = await client
      .from("games")
      .insert({
        user_id: user.id,
        mode: "stockfish",
        status: "active",
        started_at: startedAt,
        updated_at: startedAt,
        result: "ongoing",
        pgn: "",
        timeline: createInitialTimeline(),
        current_ply: 0,
        opponent_depth: selectedDepth,
        player_color: playerColor,
        time_control_label: selectedTimeControl.label,
        base_seconds: selectedTimeControl.baseSeconds,
        increment_seconds: selectedTimeControl.incrementSeconds,
        player_time_remaining_seconds: initialRemainingSeconds,
        end_reason: "ongoing",
      })
      .select("id")
      .single();

    setIsCreating(false);

    if (createError) {
      setError(createError.message);
      return;
    }

    navigate(`/play/${data.id}`, { replace: true });
  }

  return (
    <main className="app-shell">
      <header className="game-route-header">
        <Link to="/">Hub</Link>
        <div>
          <h1>New Game</h1>
          <p>Choose your side and clock</p>
        </div>
        <Link to="/history">Game History</Link>
      </header>

      <div className="game-layout setup-layout">
        <div className="board-column setup-board-column">
          <div className="board-wrap">
            <Chessboard
              options={{
                position: new Chess().fen(),
                pieces: defaultPieces,
                boardOrientation: playerColor === "w" ? "white" : "black",
                allowDragging: false,
              }}
            />
          </div>
        </div>

        <aside className="setup-panel" aria-label="New game options">
          <section className="setup-section">
            <h2>Side</h2>
            <div className="segmented-control" role="group" aria-label="Choose side">
              <button
                className={playerColor === "w" ? "selected" : undefined}
                type="button"
                onClick={() => setPlayerColor("w")}
              >
                White
              </button>
              <button
                className={playerColor === "b" ? "selected" : undefined}
                type="button"
                onClick={() => setPlayerColor("b")}
              >
                Black
              </button>
            </div>
          </section>

          <section className="setup-section">
            <h2>Stockfish Strength</h2>
            <div className="depth-selector">
              <input
                className="depth-slider"
                type="range"
                min={MIN_OPPONENT_DEPTH}
                max={MAX_OPPONENT_DEPTH}
                value={selectedDepth}
                onChange={(e) => setSelectedDepth(Number(e.target.value))}
                aria-label={`Stockfish depth: ${selectedDepth}`}
              />
              <div className="depth-labels">
                <span className="depth-value">Depth {selectedDepth}</span>
                <span className="depth-elo">Approx. Elo: {getApproxEloForDepth(selectedDepth)}</span>
              </div>
              <p className="depth-note">Higher depth = stronger play, longer thinking time.</p>
            </div>
          </section>

          <section className="setup-section">
            <h2>Time Control</h2>
            <div className="time-control-grid">
              {TIME_CONTROL_OPTIONS.map((option) => (
                <button
                  className={selectedTimeControl.label === option.label ? "selected" : undefined}
                  key={option.label}
                  type="button"
                  onClick={() => setSelectedTimeControl(option)}
                >
                  <span>{option.group}</span>
                  <strong>{option.label}</strong>
                  <small>{getTimeControlDescription(option)}</small>
                </button>
              ))}
            </div>
          </section>

          {error ? <p className="engine-alert" role="alert">{error}</p> : null}

          <button
            className="start-game-button"
            type="button"
            disabled={isCreating}
            onClick={() => {
              void startConfiguredGame();
            }}
          >
            {isCreating ? "Starting" : "Start Game"}
          </button>
        </aside>
      </div>
    </main>
  );
}

function ChessGameScreen({
  mode,
  gameId,
}: {
  mode: GameScreenMode;
  gameId: string;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [game, setGame] = useState(new Chess());
  const [gameStartedAt, setGameStartedAt] = useState(() => new Date());
  const [playerColor, setPlayerColor] = useState<PlayerColor>(DEFAULT_PLAYER_COLOR);
  const [timeControlLabel, setTimeControlLabel] = useState("Infinite");
  const [baseSeconds, setBaseSeconds] = useState<number | null>(null);
  const [incrementSeconds, setIncrementSeconds] = useState(0);
  const [playerTimeRemainingSeconds, setPlayerTimeRemainingSeconds] = useState<number | null>(null);
  const [endReason, setEndReason] = useState<GameEndReason>("ongoing");
  const [savedGameStatus, setSavedGameStatus] = useState<"active" | "completed">("active");
  const [timeline, setTimeline] = useState<TimelineEntry[]>(() => createInitialTimeline());
  const [currentPlyIndex, setCurrentPlyIndex] = useState(0);
  const [isGameLoaded, setIsGameLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [isThinking, setIsThinking] = useState(false);
  const [isStockfishReplyPending, setIsStockfishReplyPending] = useState(false);
  const [premove, setPremove] = useState<Premove | null>(null);
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [analysisSandbox, setAnalysisSandbox] = useState<AnalysisSandbox | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("loading");
  const [activeSquare, setActiveSquare] = useState<Square | null>(null);
  const [activeSource, setActiveSource] = useState<ActiveSource | null>(null);
  const [hoveredSquare, setHoveredSquare] = useState<Square | null>(null);
  const [draggedSquare, setDraggedSquare] = useState<Square | null>(null);
  const [legalMoves, setLegalMoves] = useState<Move[]>([]);
  const [timelineAnimation, setTimelineAnimation] = useState<TimelineAnimation | null>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  const gameRef = useRef(game);
  const timelineRef = useRef(timeline);
  const currentPlyIndexRef = useRef(currentPlyIndex);
  const playerColorRef = useRef<PlayerColor>(playerColor);
  const baseSecondsRef = useRef<number | null>(baseSeconds);
  const incrementSecondsRef = useRef(incrementSeconds);
  const playerTimeRemainingSecondsRef = useRef<number | null>(playerTimeRemainingSeconds);
  const savedGameStatusRef = useRef<"active" | "completed">(savedGameStatus);
  const depthRef = useRef(depth);
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
  const suppressClickAfterDragRef = useRef(false);
  const activeSquareRef = useRef<Square | null>(null);
  const activeSourceRef = useRef<ActiveSource | null>(null);
  const clockIntervalRef = useRef<number | null>(null);
  const clockPersistIntervalRef = useRef<number | null>(null);
  const clockStartedAtRef = useRef<number | null>(null);
  const clockStartingSecondsRef = useRef<number | null>(null);
  const displayedFen = analysisSandbox?.currentFen ?? timeline[currentPlyIndex]?.fen ?? game.fen();
  const {
    evaluation,
    isLoading: isEvaluationLoading,
    isOffline: isEvaluationOffline,
    error: evaluationError,
  } = useEvaluation(displayedFen, DEFAULT_EVALUATION_DEPTH, mode === "review");
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
    if (!user) return;
    const client = requireSupabase();
    let isActive = true;

    const resetTimeoutId = window.setTimeout(() => {
      if (!isActive) return;
      setIsGameLoaded(false);
      setLoadError(null);
    }, 0);

    void client
      .from("games")
      .select("*")
      .eq("id", gameId)
      .eq("user_id", user.id)
      .single()
      .then(({ data, error }) => {
        if (!isActive) return;

        if (error) {
          setLoadError(error.message);
          setIsGameLoaded(true);
          return;
        }

        const savedGame = data as SavedGame;
        const savedTimeline = parseSavedTimeline(savedGame.timeline);
        const nextPlayerColor = getPlayerColor(savedGame);
        const savedTimeControl = getTimeControlFromSavedGame(savedGame);
        const loadedGame = savedGame.pgn
          ? loadGameSnapshot({ fen: savedTimeline.at(-1)?.fen ?? new Chess().fen(), pgn: savedGame.pgn })
          : new Chess(savedTimeline.at(-1)?.fen ?? new Chess().fen());
        const nextPlyIndex = Math.max(
          0,
          Math.min(savedGame.current_ply, savedTimeline.length - 1),
        );

        gameRef.current = loadedGame;
        timelineRef.current = savedTimeline;
        currentPlyIndexRef.current = nextPlyIndex;
        playerColorRef.current = nextPlayerColor;
        baseSecondsRef.current = savedTimeControl.baseSeconds;
        incrementSecondsRef.current = savedTimeControl.incrementSeconds;
        let adjustedRemaining = savedTimeControl.remainingSeconds;
        if (
          savedGame.player_clock_started_at &&
          savedGame.status === "active" &&
          savedTimeControl.remainingSeconds !== null &&
          loadedGame.turn() === nextPlayerColor
        ) {
          const elapsedSinceSave =
            (Date.now() - new Date(savedGame.player_clock_started_at).getTime()) / 1000;
          adjustedRemaining = Math.max(0, savedTimeControl.remainingSeconds - elapsedSinceSave);
        }

        if (savedGame.status === "active" && adjustedRemaining !== null && loadedGame.turn() === nextPlayerColor) {
          clockStartedAtRef.current = Date.now();
          clockStartingSecondsRef.current = adjustedRemaining;
        } else {
          clockStartedAtRef.current = null;
          clockStartingSecondsRef.current = null;
        }

        const nextDepth = savedGame.opponent_depth ?? DEFAULT_DEPTH;
        depthRef.current = nextDepth;
        playerTimeRemainingSecondsRef.current = adjustedRemaining;
        savedGameStatusRef.current = savedGame.status;
        setGame(loadedGame);
        setTimeline(savedTimeline);
        setCurrentPlyIndex(nextPlyIndex);
        setGameStartedAt(new Date(savedGame.started_at));
        setPlayerColor(nextPlayerColor);
        setTimeControlLabel(savedTimeControl.label);
        setBaseSeconds(savedTimeControl.baseSeconds);
        setIncrementSeconds(savedTimeControl.incrementSeconds);
        setPlayerTimeRemainingSeconds(adjustedRemaining);
        setEndReason(savedGame.end_reason ?? "ongoing");
        setSavedGameStatus(savedGame.status);
        setDepth(nextDepth);
        setIsGameLoaded(true);
      });

    return () => {
      isActive = false;
      window.clearTimeout(resetTimeoutId);
    };
  }, [gameId, user]);

  useEffect(() => {
    if (mode === "review") {
      const timeoutId = window.setTimeout(() => {
        setEngineStatus("ready");
        setEngineError(null);
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }

    let isActive = true;
    const engine = new StockfishEngine();
    engineRef.current = engine;

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
  }, [mode]);

  useEffect(() => {
    if (!draggedSquare) return;

    function clearCanceledDrag(event: KeyboardEvent | PointerEvent | MouseEvent) {
      if ("key" in event && event.key !== "Escape") return;
      isDraggingRef.current = false;
      isMoveBlockingDragRef.current = false;
      draggedSquareRef.current = null;
      setDraggedSquare(null);
      setSelectedSquare(null);
      setSelectedSource(null);
      setHoveredSquare(null);
      setLegalMoves([]);
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

    const draggedPiece = displayedGame.get(draggedSquare);
    const canKeepDragging =
      !displayedGame.isGameOver() && draggedPiece?.color === playerColorRef.current;

    if (!canKeepDragging) {
      const timeoutId = window.setTimeout(() => {
        isDraggingRef.current = false;
        isMoveBlockingDragRef.current = false;
        draggedSquareRef.current = null;
        setDraggedSquare(null);
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }
  }, [draggedSquare, engineStatus, isThinking, isStockfishReplyPending, displayedGame]);

  useEffect(() => {
    if (
      !isGameLoaded ||
      mode !== "play" ||
      engineStatus !== "ready" ||
      isThinking ||
      isStockfishReplyPending ||
      !isBotTurn()
    ) {
      return;
    }

    scheduleStockfishReply(gameRef.current);
    // This effect intentionally reads the latest game details from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    engineStatus,
    isGameLoaded,
    isStockfishReplyPending,
    isThinking,
    mode,
    playerColor,
    savedGameStatus,
    currentPlyIndex,
    timeline.length,
  ]);

  useEffect(() => {
    if (
      !isGameLoaded ||
      mode !== "play" ||
      savedGameStatus !== "active" ||
      !isTimedGame(baseSeconds)
    ) {
      return;
    }

    clockIntervalRef.current = window.setInterval(() => {
      const startedAt = clockStartedAtRef.current;
      const startingSeconds = clockStartingSecondsRef.current;
      if (startedAt === null || startingSeconds === null) return;

      const elapsed = (Date.now() - startedAt) / 1000;
      const nextSeconds = Math.max(0, startingSeconds - elapsed);

      setPlayerClock(nextSeconds);

      if (nextSeconds <= 0) {
        if (clockIntervalRef.current !== null) {
          window.clearInterval(clockIntervalRef.current);
          clockIntervalRef.current = null;
        }
        void completeGame("timeout");
      }
    }, 250);

    return () => {
      if (clockIntervalRef.current !== null) {
        window.clearInterval(clockIntervalRef.current);
        clockIntervalRef.current = null;
      }
    };
    // Reads clock from refs so it never needs to restart on every move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSeconds, isGameLoaded, mode, savedGameStatus]);

  useEffect(() => {
    if (
      !isGameLoaded ||
      mode !== "play" ||
      savedGameStatus !== "active" ||
      !isTimedGame(baseSeconds)
    ) {
      return;
    }

    clockPersistIntervalRef.current = window.setInterval(() => {
      void persistClockOnly();
    }, CLOCK_PERSIST_INTERVAL_MS);

    return () => {
      if (clockPersistIntervalRef.current !== null) {
        window.clearInterval(clockPersistIntervalRef.current);
        clockPersistIntervalRef.current = null;
      }
    };
    // This effect intentionally persists the latest clock value from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSeconds, gameId, isGameLoaded, mode, savedGameStatus, user]);

  useEffect(() => {
    return () => {
      if (pendingStockfishTimeoutRef.current !== null) {
        window.clearTimeout(pendingStockfishTimeoutRef.current);
      }
      if (timelineAnimationTimeoutRef.current !== null) {
        window.clearTimeout(timelineAnimationTimeoutRef.current);
      }
      if (clockIntervalRef.current !== null) {
        window.clearInterval(clockIntervalRef.current);
      }
      if (clockPersistIntervalRef.current !== null) {
        window.clearInterval(clockPersistIntervalRef.current);
      }
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

  async function saveGameState(
    nextGame: Chess,
    nextTimeline: TimelineEntry[],
    nextCurrentPly: number,
    completionOverride?: SavedGameCompletion,
  ) {
    if (mode !== "play" || !user) return;

    const client = requireSupabase();
    const gameStatus = completionOverride ?? getSavedGameStatus(nextGame);
    const updatedAt = new Date().toISOString();

    setEndReason(gameStatus.endReason);
    setCurrentSavedGameStatus(gameStatus.status);
    setSaveStatus("saving");

    const { error } = await client
      .from("games")
      .update({
        pgn: nextGame.pgn(),
        timeline: nextTimeline,
        current_ply: nextCurrentPly,
        updated_at: updatedAt,
        status: gameStatus.status,
        result: gameStatus.result,
        completed_at: gameStatus.completedAt,
        player_time_remaining_seconds: playerTimeRemainingSecondsRef.current !== null
          ? Math.round(playerTimeRemainingSecondsRef.current)
          : null,
        player_clock_started_at: clockStartedAtRef.current
          ? new Date(clockStartedAtRef.current).toISOString()
          : null,
        end_reason: gameStatus.endReason,
      })
      .eq("id", gameId)
      .eq("user_id", user.id);

    setSaveStatus(error ? "failed" : "saved");

    if (error) {
      setEngineError(`Save failed: ${error.message}`);
    }
  }

  async function persistClockOnly() {
    if (
      mode !== "play" ||
      !user ||
      savedGameStatusRef.current === "completed" ||
      !isTimedGame(baseSecondsRef.current)
    ) {
      return;
    }

    const now = Date.now();
    const remaining = playerTimeRemainingSecondsRef.current;

    if (clockStartedAtRef.current !== null) {
      clockStartedAtRef.current = now;
      clockStartingSecondsRef.current = remaining;
    }

    const { error } = await requireSupabase()
      .from("games")
      .update({
        player_time_remaining_seconds: remaining !== null ? Math.round(remaining) : null,
        player_clock_started_at: clockStartedAtRef.current
          ? new Date(clockStartedAtRef.current).toISOString()
          : null,
        updated_at: new Date(now).toISOString(),
      })
      .eq("id", gameId)
      .eq("user_id", user.id);

    if (error) {
      setSaveStatus("failed");
      setEngineError(`Clock save failed: ${error.message}`);
    }
  }

  async function completeGame(reason: Exclude<GameEndReason, "ongoing">) {
    if (mode !== "play" || savedGameStatusRef.current === "completed") return;

    const completedAt = new Date().toISOString();
    const result: GameResult = reason === "draw" ? "draw" : getOpponentResult(playerColorRef.current);
    const completion: SavedGameCompletion = {
      status: "completed",
      result,
      completedAt,
      endReason: reason,
    };

    clearPendingStockfishDelay();
    searchIdRef.current += 1;
    setEngineThinking(false);
    setStockfishReplyPending(false);
    setQueuedPremove(null);
    clearInteractionState();
    clockStartedAtRef.current = null;
    clockStartingSecondsRef.current = null;
    await saveGameState(gameRef.current, timelineRef.current, currentPlyIndexRef.current, completion);
  }

  function setCurrentGame(nextGame: Chess) {
    gameRef.current = nextGame;
    setGame(nextGame);
  }

  function setPlayerClock(nextSeconds: number | null) {
    const boundedSeconds = nextSeconds === null ? null : Math.max(0, nextSeconds);
    playerTimeRemainingSecondsRef.current = boundedSeconds;
    setPlayerTimeRemainingSeconds(boundedSeconds);
  }

  function armClock(remainingSeconds: number) {
    const now = Date.now();
    clockStartedAtRef.current = now;
    clockStartingSecondsRef.current = remainingSeconds;
  }

  function makeAnalysisMove(from: Square, to: Square): boolean {
    const baseFen = analysisSandbox?.currentFen ?? timeline[currentPlyIndex]?.fen ?? game.fen();
    const analysisGame = new Chess(baseFen);
    const move = analysisGame.move({ from, to, promotion: "q" });
    if (!move) return false;

    const sandboxBase = analysisSandbox ?? {
      basePly: currentPlyIndex,
      baseFen: timeline[currentPlyIndex]?.fen ?? game.fen(),
      currentFen: baseFen,
      moves: [] as AnalysisMove[],
    };

    setAnalysisSandbox({
      basePly: sandboxBase.basePly,
      baseFen: sandboxBase.baseFen,
      currentFen: analysisGame.fen(),
      moves: [
        ...sandboxBase.moves,
        { from: move.from, to: move.to, san: move.san, fen: analysisGame.fen(), promotion: move.promotion },
      ],
    });
    clearInteractionState();
    playChessSound(getSoundForMove(analysisGame, move));
    return true;
  }

  function resetAnalysis() {
    setAnalysisSandbox(null);
    clearInteractionState();
  }

  function setCurrentSavedGameStatus(nextStatus: "active" | "completed") {
    savedGameStatusRef.current = nextStatus;
    setSavedGameStatus(nextStatus);
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

    const nextTimeline = [...previousTimeline, nextEntry];

    setTimelineEntries(nextTimeline);

    if (wasViewingLatest) {
      setViewedPlyIndex(nextPly);
    }

    void saveGameState(gameAfterMove, nextTimeline, nextPly);
  }

  function isBotTurn(gameToCheck = gameRef.current) {
    return (
      mode === "play" &&
      savedGameStatusRef.current === "active" &&
      currentPlyIndexRef.current === timelineRef.current.length - 1 &&
      !gameToCheck.isGameOver() &&
      gameToCheck.turn() !== playerColorRef.current
    );
  }

  function scheduleStockfishReply(gameBeforeStockfishMove: Chess) {
    if (!isBotTurn(gameBeforeStockfishMove)) return;
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
    if (!isBotTurn(loadGameSnapshot(snapshot))) return;

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
      const bestMove = await engine.findBestMove(snapshot.fen, depthRef.current);

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
        if (isTimedGame(baseSecondsRef.current)) {
          armClock(playerTimeRemainingSecondsRef.current ?? 0);
        }
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

  function isGameActive() {
    return savedGameStatusRef.current === "active" && !gameRef.current.isGameOver();
  }

  function canSelectPlayerPieces() {
    return mode === "play" && isGameActive();
  }

  function canMovePlayerPieces() {
    const currentGame = gameRef.current;

    return (
      currentGame.turn() === playerColorRef.current &&
      mode === "play" &&
      currentPlyIndexRef.current === timelineRef.current.length - 1 &&
      !isStockfishThinking() &&
      isGameActive()
    );
  }

  function canSetPremove() {
    const currentGame = gameRef.current;

    return (
      currentPlyIndexRef.current === timelineRef.current.length - 1 &&
      mode === "play" &&
      isGameActive() &&
      (currentGame.turn() !== playerColorRef.current || isStockfishThinking())
    );
  }

  function canQueuePremove(sourceSquare: Square, targetSquare: Square) {
    if (!canSetPremove() || sourceSquare === targetSquare) {
      return false;
    }

    const sourcePiece = displayedGame.get(sourceSquare);
    const targetPiece = displayedGame.get(targetSquare);

    return (
      sourcePiece?.color === playerColorRef.current &&
      targetPiece?.color !== playerColorRef.current
    );
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
    return canSelectPlayerPieces() && piece?.color === playerColorRef.current;
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
    if (isTimedGame(baseSecondsRef.current)) {
      setPlayerClock((playerTimeRemainingSecondsRef.current ?? 0) + incrementSecondsRef.current);
      clockStartedAtRef.current = null;
      clockStartingSecondsRef.current = null;
    }
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

    if (selectedPiece?.color !== playerColorRef.current) {
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
    if (!canMovePlayerPieces()) {
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
    if (isTimedGame(baseSecondsRef.current)) {
      setPlayerClock((playerTimeRemainingSecondsRef.current ?? 0) + incrementSecondsRef.current);
      clockStartedAtRef.current = null;
      clockStartingSecondsRef.current = null;
    }
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

    if (mode === "review") {
      if (square === activeSquare) {
        clearInteractionState();
        return;
      }
      if (activeSquare && legalMoves.some((move) => move.to === square)) {
        makeAnalysisMove(activeSquare, square);
        return;
      }
      if (displayedGame.get(square) !== undefined) {
        const moves = getLegalMovesForSquare(square, displayedGame);
        setSelectedSquare(square);
        setSelectedSource("click");
        setHoveredSquare(null);
        setLegalMoves(moves);
        return;
      }
      clearInteractionState();
      return;
    }

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
      if (canMovePlayerPieces()) {
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

    if (mode === "review") {
      if (displayedGame.get(square) !== undefined) {
        beginDrag(square, false);
        const moves = getLegalMovesForSquare(square, displayedGame);
        setSelectedSquare(square);
        setSelectedSource("drag");
        setLegalMoves(moves);
        return;
      }
      endDrag();
      clearInteractionState();
      return;
    }

    if (isViewingLatest && isSelectableHumanPiece(square)) {
      if (canSetPremove()) {
        setQueuedPremove(null);
      }
      beginDrag(square, canMovePlayerPieces());
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

      if (mode === "review") {
        return makeAnalysisMove(sourceSquare, targetSquare);
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
    if (mode === "review") {
      if (!activeSquare && !draggedSquare && displayedGame.get(square) !== undefined) {
        setHoveredSquare(square);
      }
      return;
    }
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
    setAnalysisSandbox(null);
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
    setAnalysisSandbox(null);
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
    navigate("/play/new");
  }

  function resignGame() {
    if (savedGameStatusRef.current === "completed") return;
    const didConfirm = window.confirm("Resign this game?");
    if (!didConfirm) return;

    void completeGame("resignation");
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
  const boardOrientation = playerColor === "w" ? "white" : "black";
  const showEvaluationBar = mode === "review";
  const timelineAnimationStyle = getTimelineAnimationStyle(
    timelineAnimation,
    boardWidth,
    boardOrientation,
  );
  const bestMoveArrow: Arrow[] =
    showEvaluationBar && evaluation?.bestMove && evaluation.fen === displayedFen
      ? [{ startSquare: evaluation.bestMove.from, endSquare: evaluation.bestMove.to, color: "rgba(52, 168, 83, 0.72)" }]
      : [];

  if (!isGameLoaded) {
    return <LoadingScreen />;
  }

  if (loadError) {
    return (
      <main className="prototype-shell">
        <section className="auth-panel">
          <h1>Game unavailable</h1>
          <p className="form-message">{loadError}</p>
          <Link to="/">Back to hub</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="game-route-header">
        <Link to="/">Hub</Link>
        <div>
          <h1>{mode === "review" ? "Game Review" : "Chess vs Stockfish"}</h1>
          <p>
            {mode === "review"
              ? "Review mode: moves are locked, Eval Bar remains active"
              : saveStatus === "saving"
                ? "Saving game"
                : saveStatus === "failed"
                  ? "Save failed"
                  : "Saved game"}
          </p>
        </div>
        {mode === "play" ? <Link to={`/review/${gameId}`}>Review</Link> : <Link to="/history">Game History</Link>}
      </header>

      <div className={`game-layout ${showEvaluationBar ? "" : "game-layout-no-eval"}`}>
        <div className="board-column">
          <CapturedPiecesRow
            capturedPieces={capturedPieces.byBlack}
            pieceColor="w"
            advantage={blackMaterialAdvantage}
            side="top"
          />
          <div className={`board-with-evaluation ${showEvaluationBar ? "" : "board-without-evaluation"}`}>
            {showEvaluationBar ? (
              <EvaluationBar
                evaluation={evaluation}
                isLoading={isEvaluationLoading}
                isOffline={isEvaluationOffline}
                error={evaluationError}
                targetDepth={DEFAULT_EVALUATION_DEPTH}
              />
            ) : null}
            <div className="board-wrap" ref={boardWrapRef}>
              <Chessboard
                options={{
                  position: displayedFen,
                  pieces: timelinePieces,
                  boardOrientation,
                  squareStyles: buildCustomSquareStyles(),
                  showAnimations: !timelineAnimation,
                  animationDurationInMs: TIMELINE_MOVE_ANIMATION_MS,
                  allowDragging: mode === "review" || (isViewingLatest && canSelectPlayerPieces()),
                  canDragPiece: mode === "review"
                    ? ({ square }) => isSquare(square) && displayedGame.get(square) !== undefined
                    : ({ piece, square }) =>
                        isViewingLatest &&
                        piece.pieceType.startsWith(playerColorRef.current) &&
                        isSquare(square) &&
                        isSelectableHumanPiece(square),
                  draggingPieceGhostStyle: draggedSquare && isDraggingRef.current
                    ? HIDDEN_DRAG_SOURCE_PIECE_STYLE
                    : VISIBLE_DRAG_SOURCE_PIECE_STYLE,
                  arrows: bestMoveArrow,
                  allowDrawingArrows: false,
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
          playerColor={playerColor}
          timeControlLabel={timeControlLabel}
          playerTimeRemainingSeconds={playerTimeRemainingSeconds}
          endReason={endReason}
          isGameCompleted={savedGameStatus === "completed"}
          canResign={mode === "play" && savedGameStatus === "active"}
          moveRows={moveRows}
          currentPlyIndex={currentPlyIndex}
          latestPly={latestPly}
          onSelectMove={selectTimelineMove}
          onFirstPly={goToFirstPly}
          onPreviousPly={goToPreviousPly}
          onNextPly={goToNextPly}
          onLastPly={goToLastPly}
          onNewGame={startNewGame}
          onResign={resignGame}
          engineStatus={engineStatus}
          engineError={engineError}
          isThinking={isThinking}
          isReplyPending={isStockfishReplyPending}
          opponentDepth={depth}
          isAnalysisActive={analysisSandbox !== null}
          analysisMoveCount={analysisSandbox?.moves.length ?? 0}
          onResetAnalysis={resetAnalysis}
        />
      </div>
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/auth" element={<AuthScreen />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <HubScreen />
              </ProtectedRoute>
            }
          />
          <Route
            path="/play/new"
            element={
              <ProtectedRoute>
                <NewGameRoute />
              </ProtectedRoute>
            }
          />
          <Route
            path="/play/:gameId"
            element={
              <ProtectedRoute>
                <PlayRoute />
              </ProtectedRoute>
            }
          />
          <Route
            path="/history"
            element={
              <ProtectedRoute>
                <HistoryScreen />
              </ProtectedRoute>
            }
          />
          <Route
            path="/review/:gameId"
            element={
              <ProtectedRoute>
                <ReviewRoute />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SettingsScreen />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

function getTimelineAnimationStyle(
  animation: TimelineAnimation | null,
  boardWidth: number,
  boardOrientation: "white" | "black",
): CSSProperties | undefined {
  if (!animation || boardWidth <= 0) return undefined;

  const squareSize = boardWidth / 8;
  const from = getRelativeCoords(boardOrientation, boardWidth, 8, 8, animation.from);
  const to = getRelativeCoords(boardOrientation, boardWidth, 8, 8, animation.to);

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
