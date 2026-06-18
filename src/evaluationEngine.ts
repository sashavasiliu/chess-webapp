import {
  STOCKFISH_WORKER_PATH,
  STOCKFISH_WASM_PATH,
  INIT_TIMEOUT_MS,
  looksLikeHtml,
  hasWasmMagic,
  getErrorMessage,
  type Deferred,
  type AssetKind,
} from "./lib/stockfishWorkerUtils";

const SEARCH_TIMEOUT_MS = 300_000;

export type BestMove = {
  uci: string;
  from: string;
  to: string;
  promotion: string | null;
};

export type Evaluation =
  | {
      type: "cp";
      value: number;
      depth: number;
      fen: string;
      bestMove: BestMove | null;
    }
  | {
      type: "mate";
      value: number;
      depth: number;
      fen: string;
      bestMove: BestMove | null;
    };


type Waiter = Deferred<void> & {
  kind: "uciok" | "readyok";
  timeoutId: ReturnType<typeof setTimeout>;
};

type ActiveSearch = Deferred<Evaluation> & {
  id: number;
  fen: string;
  depth: number;
  sideMultiplier: 1 | -1;
  latestEvaluation: Evaluation | null;
  onProgress: ((evaluation: Evaluation) => void) | undefined;
  timeoutId: ReturnType<typeof setTimeout>;
};


export class EvaluationEngine {
  private worker: Worker | null = null;
  private initPromise: Promise<void>;
  private waiters: Waiter[] = [];
  private activeSearch: ActiveSearch | null = null;
  private isQuit = false;
  private isInitialized = false;
  private latestRequestId = 0;
  private nextSearchId = 0;
  private shouldLogInitMessages = true;

  constructor() {
    this.initPromise = this.initialize();
    void this.initPromise.catch(() => undefined);
  }

  ready(): Promise<void> {
    return this.initPromise;
  }

  isReady(): boolean {
    return this.isInitialized && !this.isQuit;
  }

  async evaluate(
    fen: string,
    depth: number,
    onProgress?: (evaluation: Evaluation) => void,
  ): Promise<Evaluation> {
    const requestId = this.latestRequestId + 1;
    this.latestRequestId = requestId;

    await this.ensureReady();
    this.throwIfStaleRequest(requestId);

    this.interruptActiveSearch("Evaluation interrupted by a newer request.");
    this.post("ucinewgame");
    await this.waitUntilReady();
    await this.ensureReady();
    this.throwIfStaleRequest(requestId);

    return new Promise((resolve, reject) => {
      const search: ActiveSearch = {
        id: this.nextSearchId + 1,
        fen,
        depth,
        sideMultiplier: getSideMultiplier(fen),
        latestEvaluation: null,
        onProgress,
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          if (this.activeSearch?.id !== search.id) return;
          this.post("stop");
          this.finishActiveSearch(
            search.latestEvaluation ??
              new Error(`Stockfish did not return an evaluation within ${SEARCH_TIMEOUT_MS}ms.`),
          );
        }, SEARCH_TIMEOUT_MS),
      };

      this.nextSearchId = search.id;
      this.activeSearch = search;
      this.post(`position fen ${fen}`);
      this.post(`go depth ${depth}`);
    });
  }

  stop(message = "Evaluation stopped.") {
    if (this.isQuit) return;
    this.latestRequestId += 1;

    if (!this.worker) return;

    this.interruptActiveSearch(message);
  }

  quit() {
    if (this.isQuit) return;

    this.isQuit = true;
    this.rejectWaiters(
      new Error("Evaluation worker was terminated because the React component unmounted."),
    );
    this.cancelActiveSearch(
      "Evaluation worker was terminated because the React component unmounted.",
    );

    if (this.worker) {
      this.post("quit");
      this.worker.terminate();
      this.worker = null;
    }
  }

  private async initialize() {
    await preflightStockfishAssets();

    if (this.isQuit) {
      throw new Error("Stockfish evaluation initialization was canceled before the worker started.");
    }

    this.worker = new Worker(STOCKFISH_WORKER_PATH);
    this.worker.onmessage = this.handleMessage;
    this.worker.onerror = this.handleError;
    this.worker.onmessageerror = this.handleMessageError;

    this.post("uci");
    await this.waitFor("uciok");

    this.post("isready");
    await this.waitFor("readyok");

    this.isInitialized = true;
    this.shouldLogInitMessages = false;
    console.info("[Stockfish evaluation] ready");
  }

  private async ensureReady() {
    if (this.isQuit) {
      throw new Error("Stockfish evaluation worker has been shut down.");
    }

    try {
      await this.initPromise;
    } catch (error) {
      throw new Error(`Stockfish evaluation is not ready: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }

    if (!this.worker || !this.isInitialized) {
      throw new Error("Stockfish evaluation is not ready yet.");
    }
  }

  private throwIfStaleRequest(requestId: number) {
    if (requestId !== this.latestRequestId) {
      throw new Error("Evaluation interrupted by a newer request.");
    }
  }

  private waitUntilReady(): Promise<void> {
    this.post("isready");
    return this.waitFor("readyok");
  }

  private waitFor(kind: "uciok" | "readyok"): Promise<void> {
    if (this.isQuit) {
      return Promise.reject(new Error(`Cannot wait for ${kind}; Stockfish evaluation is shut down.`));
    }

    if (!this.worker) {
      return Promise.reject(
        new Error(`Cannot wait for ${kind}; Stockfish evaluation worker was not created.`),
      );
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`Timed out waiting for Stockfish evaluation ${kind}.`));
        }, INIT_TIMEOUT_MS),
      };

      this.waiters.push(waiter);
    });
  }

  private handleMessage = (event: MessageEvent) => {
    const line = String(event.data).trim();

    if (this.shouldLogInitMessages) {
      console.info("[Stockfish evaluation init message]", line);
    }

    if (line === "uciok" || line === "readyok") {
      this.resolveWaiters(line);
      return;
    }

    const activeSearch = this.activeSearch;
    if (!activeSearch) return;

    if (line.startsWith("info ")) {
      const evaluation = parseInfoLine(line, activeSearch);
      if (!evaluation) return;

      activeSearch.latestEvaluation = evaluation;
      activeSearch.onProgress?.(evaluation);

      if (evaluation.depth >= activeSearch.depth) {
        this.post("stop");
        this.finishActiveSearch(evaluation);
      }
      return;
    }

    if (line.startsWith("bestmove ")) {
      this.finishActiveSearch(
        activeSearch.latestEvaluation ??
          new Error("Stockfish evaluation finished without reporting a score."),
      );
    }
  };

  private handleError = (event: ErrorEvent) => {
    console.error("[Stockfish evaluation worker error]", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });

    this.fail(
      new Error(
        `Stockfish evaluation worker error: ${event.message || "unknown error"}${formatLocation(event)}`,
      ),
    );
  };

  private handleMessageError = (event: MessageEvent) => {
    console.error("[Stockfish evaluation worker messageerror]", {
      message: "messageerror",
      data: event.data,
    });

    this.fail(new Error("Stockfish evaluation worker sent a message that could not be deserialized."));
  };

  private post(command: string) {
    if (this.isQuit || !this.worker) return;
    this.worker.postMessage(command);
  }

  private finishActiveSearch(result: Evaluation | Error) {
    const activeSearch = this.activeSearch;
    if (!activeSearch) return;

    clearTimeout(activeSearch.timeoutId);
    this.activeSearch = null;

    if (result instanceof Error) {
      activeSearch.reject(result);
    } else {
      activeSearch.resolve(result);
    }
  }

  private cancelActiveSearch(message: string) {
    const activeSearch = this.activeSearch;
    if (!activeSearch) return;

    clearTimeout(activeSearch.timeoutId);
    this.activeSearch = null;
    activeSearch.reject(new Error(message));
  }

  private interruptActiveSearch(message: string) {
    if (!this.activeSearch) return;

    this.post("stop");
    this.cancelActiveSearch(message);
  }

  private resolveWaiters(kind: "uciok" | "readyok") {
    const matchingWaiters = this.waiters.filter((waiter) => waiter.kind === kind);
    this.waiters = this.waiters.filter((waiter) => waiter.kind !== kind);

    matchingWaiters.forEach((waiter) => {
      clearTimeout(waiter.timeoutId);
      waiter.resolve();
    });
  }

  private rejectWaiters(error: Error) {
    this.waiters.splice(0).forEach((waiter) => {
      clearTimeout(waiter.timeoutId);
      waiter.reject(error);
    });
  }

  private fail(error: Error) {
    this.rejectWaiters(error);
    this.cancelActiveSearch(error.message);
  }
}

function getSideMultiplier(fen: string): 1 | -1 {
  return fen.split(/\s+/)[1] === "b" ? -1 : 1;
}

function parseInfoLine(line: string, search: ActiveSearch): Evaluation | null {
  const depthMatch = line.match(/\bdepth\s+(\d+)/);
  const cpMatch = line.match(/\bscore\s+cp\s+(-?\d+)/);
  const mateMatch = line.match(/\bscore\s+mate\s+(-?\d+)/);

  if (!depthMatch) return null;

  const depth = Number(depthMatch[1]);
  const bestMove = parseBestMoveFromPv(line);

  if (cpMatch) {
    return {
      type: "cp",
      value: Number(cpMatch[1]) * search.sideMultiplier,
      depth,
      fen: search.fen,
      bestMove,
    };
  }

  if (mateMatch) {
    return {
      type: "mate",
      value: Number(mateMatch[1]) * search.sideMultiplier,
      depth,
      fen: search.fen,
      bestMove,
    };
  }

  return null;
}

function parseBestMoveFromPv(line: string): BestMove | null {
  const pvMatch = line.match(/\bpv\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
  if (!pvMatch) return null;

  const uci = pvMatch[1];
  return {
    uci,
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length === 5 ? uci[4] ?? null : null,
  };
}

async function preflightStockfishAssets() {
  console.groupCollapsed("[Stockfish evaluation preflight]");

  try {
    await preflightAsset(STOCKFISH_WORKER_PATH, "JavaScript");
    await preflightAsset(STOCKFISH_WASM_PATH, "WASM");
  } finally {
    console.groupEnd();
  }
}

async function preflightAsset(path: string, kind: AssetKind) {
  let response: Response;

  try {
    response = await fetch(path, { cache: "no-store" });
  } catch (error) {
    throw new Error(
      `Could not fetch Stockfish evaluation ${kind} asset at ${path}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      throw new Error(
        `Stockfish evaluation ${kind} asset is missing: GET ${path} returned ${response.status}.`,
      );
    }

    throw new Error(
      `Stockfish evaluation ${kind} asset could not be loaded: GET ${path} returned ${response.status} ${response.statusText}.`,
    );
  }

  const sniffText = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();

  if (looksLikeHtml(sniffText)) {
    throw new Error(
      `Stockfish evaluation ${kind} asset at ${path} is HTML, not ${kind}.`,
    );
  }

  validateMimeType(path, kind, contentType);

  if (kind === "WASM" && !hasWasmMagic(bytes)) {
    throw new Error(
      `Stockfish evaluation WASM asset at ${path} is not a valid WebAssembly binary.`,
    );
  }
}

function validateMimeType(path: string, kind: AssetKind, contentType: string) {
  const mimeType = contentType.split(";")[0].trim().toLowerCase();

  if (!mimeType) return;

  const allowedJavaScriptTypes = new Set([
    "application/ecmascript",
    "application/javascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
  ]);

  const allowedWasmTypes = new Set([
    "application/octet-stream",
    "application/wasm",
    "binary/octet-stream",
  ]);

  if (kind === "JavaScript" && !allowedJavaScriptTypes.has(mimeType)) {
    throw new Error(
      `Stockfish evaluation JavaScript asset at ${path} has MIME type "${contentType}".`,
    );
  }

  if (kind === "WASM" && !allowedWasmTypes.has(mimeType)) {
    throw new Error(
      `Stockfish evaluation WASM asset at ${path} has MIME type "${contentType}".`,
    );
  }
}

function formatLocation(event: ErrorEvent) {
  const parts = [
    event.filename ? `file ${event.filename}` : "",
    event.lineno ? `line ${event.lineno}` : "",
    event.colno ? `column ${event.colno}` : "",
  ].filter(Boolean);

  return parts.length ? ` (${parts.join(", ")})` : "";
}

