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


type Waiter = Deferred<void> & {
  kind: "uciok" | "readyok";
  timeoutId: ReturnType<typeof setTimeout>;
};


export class StockfishEngine {
  private worker: Worker | null = null;
  private initPromise: Promise<void>;
  private waiters: Waiter[] = [];
  private pendingSearch: Deferred<string> | null = null;
  private isQuit = false;
  private isInitialized = false;
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

  async findBestMove(fen: string, depth: number): Promise<string> {
    if (this.isQuit) {
      throw new Error("Stockfish worker has been shut down.");
    }

    if (this.pendingSearch) {
      throw new Error("Stockfish is already searching.");
    }

    try {
      await this.initPromise;
    } catch (error) {
      throw new Error(`Stockfish is not ready: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }

    if (!this.worker || !this.isInitialized) {
      throw new Error("Stockfish is not ready yet.");
    }

    return new Promise((resolve, reject) => {
      this.pendingSearch = { resolve, reject };
      this.post(`position fen ${fen}`);
      this.post(`go depth ${depth}`);
    });
  }

  async newGame(): Promise<void> {
    await this.ensureReady();

    if (this.pendingSearch) {
      this.pendingSearch.reject(new Error("New game started before search finished."));
      this.pendingSearch = null;
    }

    this.post("ucinewgame");
    await this.waitUntilReady();
  }

  stop() {
    if (this.isQuit || !this.worker) return;

    if (this.pendingSearch) {
      this.pendingSearch.reject(new Error("Stockfish search stopped."));
      this.pendingSearch = null;
    }

    this.post("stop");
  }

  quit() {
    if (this.isQuit) return;

    this.isQuit = true;

    if (this.pendingSearch) {
      this.pendingSearch.reject(
        new Error("Stockfish worker was terminated because the React component unmounted."),
      );
      this.pendingSearch = null;
    }

    this.rejectWaiters(
      new Error("Stockfish worker was terminated because the React component unmounted."),
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
      throw new Error("Stockfish initialization was canceled before the worker started.");
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
    console.info("[Stockfish] ready");
  }

  private async ensureReady() {
    if (this.isQuit) {
      throw new Error("Stockfish worker has been shut down.");
    }

    await this.initPromise;

    if (!this.worker || !this.isInitialized) {
      throw new Error("Stockfish is not ready yet.");
    }
  }

  private waitUntilReady(): Promise<void> {
    this.post("isready");
    return this.waitFor("readyok");
  }

  private waitFor(kind: "uciok" | "readyok"): Promise<void> {
    if (this.isQuit) {
      return Promise.reject(new Error(`Cannot wait for ${kind}; Stockfish is shut down.`));
    }

    if (!this.worker) {
      return Promise.reject(new Error(`Cannot wait for ${kind}; Stockfish worker was not created.`));
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        resolve,
        reject,
        timeoutId: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`Timed out waiting for Stockfish ${kind}.`));
        }, INIT_TIMEOUT_MS),
      };

      this.waiters.push(waiter);
    });
  }

  private handleMessage = (event: MessageEvent) => {
    const line = String(event.data).trim();

    if (this.shouldLogInitMessages) {
      console.info("[Stockfish init message]", line);
    }

    if (line === "uciok" || line === "readyok") {
      this.resolveWaiters(line);
      return;
    }

    if (line.startsWith("bestmove ")) {
      const [, bestMove] = line.split(/\s+/);
      const pendingSearch = this.pendingSearch;
      this.pendingSearch = null;

      if (!pendingSearch) return;

      if (!bestMove || bestMove === "(none)") {
        pendingSearch.reject(new Error("Stockfish did not return a legal move."));
        return;
      }

      pendingSearch.resolve(bestMove);
    }
  };

  private handleError = (event: ErrorEvent) => {
    console.error("[Stockfish worker error]", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });

    this.fail(
      new Error(
        `Stockfish worker error: ${event.message || "unknown error"}${formatLocation(event)}`,
      ),
    );
  };

  private handleMessageError = (event: MessageEvent) => {
    console.error("[Stockfish worker messageerror]", {
      message: "messageerror",
      filename: undefined,
      lineno: undefined,
      colno: undefined,
      data: event.data,
    });

    this.fail(new Error("Stockfish worker sent a message that could not be deserialized."));
  };

  private post(command: string) {
    if (this.isQuit || !this.worker) return;
    this.worker.postMessage(command);
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

    if (this.pendingSearch) {
      this.pendingSearch.reject(error);
      this.pendingSearch = null;
    }
  }
}

async function preflightStockfishAssets() {
  console.groupCollapsed("[Stockfish preflight]");

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
      `Could not fetch Stockfish ${kind} asset at ${path}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const contentLength = response.headers.get("content-length");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const size = contentLength ? Number(contentLength) : bytes.byteLength;

  console.info(`${path}`, {
    status: response.status,
    statusText: response.statusText,
    contentType: contentType || "(none)",
    size,
  });

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      throw new Error(
        `Stockfish ${kind} asset is missing: GET ${path} returned ${response.status}. Download the v18 lite single-threaded build from nmrugg/stockfish.js and place it at public${path}.`,
      );
    }

    throw new Error(
      `Stockfish ${kind} asset could not be loaded: GET ${path} returned ${response.status} ${response.statusText}.`,
    );
  }

  const sniffText = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();

  if (looksLikeHtml(sniffText)) {
    throw new Error(
      `Stockfish ${kind} asset at ${path} is HTML, not ${kind}. This usually means a GitHub release page was saved instead of the raw Stockfish file.`,
    );
  }

  validateMimeType(path, kind, contentType);

  if (kind === "WASM" && !hasWasmMagic(bytes)) {
    throw new Error(
      `Stockfish WASM asset at ${path} is not a valid WebAssembly binary. Expected the file to start with the WASM magic bytes.`,
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
      `Stockfish JavaScript asset at ${path} has MIME type "${contentType}". Expected a JavaScript MIME type so the browser can create a classic Worker.`,
    );
  }

  if (kind === "WASM" && !allowedWasmTypes.has(mimeType)) {
    throw new Error(
      `Stockfish WASM asset at ${path} has MIME type "${contentType}". Expected application/wasm or application/octet-stream.`,
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

