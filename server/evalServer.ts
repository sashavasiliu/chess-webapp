import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { validateFen } from "chess.js";

type Evaluation =
  | {
      type: "cp";
      value: number;
      depth: number;
      fen: string;
    }
  | {
      type: "mate";
      value: number;
      depth: number;
      fen: string;
    };

type PendingWaiter = {
  test: (line: string) => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type ActiveSearch = {
  id: number;
  fen: string;
  depth: number;
  sideMultiplier: 1 | -1;
  latestEvaluation: Evaluation | null;
  onProgress: ((evaluation: Evaluation) => void) | undefined;
  resolve: (evaluation: Evaluation) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const DEFAULT_PORT = 3001;
const DEFAULT_DEPTH = 14;
const MAX_DEPTH = 26;
const READY_TIMEOUT_MS = 5_000;
const SEARCH_TIMEOUT_MS = 300_000;
const isDev = process.env.NODE_ENV !== "production";

class NativeStockfishEvaluator {
  private process: ChildProcessWithoutNullStreams | null = null;
  private startupPromise: Promise<void> | null = null;
  private waiters: PendingWaiter[] = [];
  private activeSearch: ActiveSearch | null = null;
  private latestRequestId = 0;
  private nextSearchId = 0;
  private bufferedOutput = "";
  private readonly stockfishPath: string | undefined;

  constructor(stockfishPath: string | undefined) {
    this.stockfishPath = stockfishPath;
  }

  async evaluate(fen: string, depth: number, onProgress?: (evaluation: Evaluation) => void) {
    const requestId = this.latestRequestId + 1;
    this.latestRequestId = requestId;

    if (isDev) {
      console.log(`[eval] requestId=${requestId} received fen="${fen}" depth=${depth}`);
    }

    await this.ensureReady();
    this.throwIfStaleRequest(requestId);
    const engine = this.process;

    if (!engine) {
      throw new Error("Stockfish process is not available.");
    }

    this.cancelActiveSearch("Evaluation interrupted by a newer request.");
    this.send("stop");
    this.send("ucinewgame");
    await this.waitForReady();
    this.throwIfStaleRequest(requestId);

    return new Promise<Evaluation>((resolve, reject) => {
      const search: ActiveSearch = {
        id: this.nextSearchId + 1,
        fen,
        depth,
        sideMultiplier: getSideMultiplier(fen),
        latestEvaluation: null,
        onProgress,
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (this.activeSearch?.id !== search.id) return;
          this.send("stop");
          this.finishActiveSearch(
            search.latestEvaluation ??
              new Error(`Stockfish did not return an evaluation within ${SEARCH_TIMEOUT_MS}ms.`),
          );
        }, SEARCH_TIMEOUT_MS),
      };

      this.nextSearchId = search.id;
      this.activeSearch = search;

      if (isDev) {
        console.log(`[eval] requestId=${requestId} UCI: position fen ${fen}`);
        console.log(`[eval] requestId=${requestId} UCI: go depth ${depth}`);
      }

      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  private throwIfStaleRequest(requestId: number) {
    if (requestId !== this.latestRequestId) {
      throw new Error("Evaluation interrupted by a newer request.");
    }
  }

  private async ensureReady() {
    const stockfishPath = this.stockfishPath;

    if (!stockfishPath) {
      throw new Error("STOCKFISH_PATH is not set.");
    }

    if (!existsSync(stockfishPath)) {
      throw new Error(`STOCKFISH_PATH does not exist: ${stockfishPath}`);
    }

    if (this.startupPromise) {
      return this.startupPromise;
    }

    this.startupPromise = new Promise<void>((resolve, reject) => {
      const engine = spawn(stockfishPath);

      this.process = engine;

      engine.stdout.setEncoding("utf8");
      engine.stderr.setEncoding("utf8");
      engine.stdout.on("data", (chunk: string) => this.handleOutput(chunk));
      engine.stderr.on("data", (chunk: string) => {
        const message = chunk.trim();
        if (message) {
          console.error(`[stockfish] ${message}`);
        }
      });
      engine.once("error", (error) => {
        this.rejectAll(error);
        reject(error);
      });
      engine.once("exit", (code, signal) => {
        const error = new Error(
          `Stockfish exited unexpectedly with code ${code ?? "null"} and signal ${signal ?? "null"}.`,
        );
        this.process = null;
        this.startupPromise = null;
        this.rejectAll(error);
      });

      void this.waitForLine((line) => line === "uciok", READY_TIMEOUT_MS)
        .then(() => this.waitForReady())
        .then(resolve)
        .catch(reject);

      this.send("uci");
    });

    return this.startupPromise;
  }

  private waitForReady() {
    this.send("isready");
    return this.waitForLine((line) => line === "readyok", READY_TIMEOUT_MS);
  }

  private waitForLine(test: (line: string) => boolean, timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
      const waiter: PendingWaiter = {
        test,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`Timed out waiting for Stockfish after ${timeoutMs}ms.`));
        }, timeoutMs),
      };

      this.waiters.push(waiter);
    });
  }

  private handleOutput(chunk: string) {
    this.bufferedOutput += chunk;
    const lines = this.bufferedOutput.split(/\r?\n/);
    this.bufferedOutput = lines.pop() ?? "";

    lines.forEach((line) => this.handleLine(line.trim()));
  }

  private handleLine(line: string) {
    if (!line) return;

    this.waiters
      .filter((waiter) => waiter.test(line))
      .forEach((waiter) => {
        clearTimeout(waiter.timeout);
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        waiter.resolve();
      });

    const activeSearch = this.activeSearch;
    if (!activeSearch) return;

    if (line.startsWith("info ")) {
      const evaluation = parseInfoLine(line, activeSearch);
      if (evaluation) {
        activeSearch.latestEvaluation = evaluation;
        activeSearch.onProgress?.(evaluation);

        if (isDev) {
          console.log(
            `[eval] searchId=${activeSearch.id} depth=${evaluation.depth} score ${evaluation.type} ${evaluation.value}`,
          );
        }

        if (evaluation.depth >= activeSearch.depth) {
          this.send("stop");
          this.finishActiveSearch(evaluation);
        }
      }
      return;
    }

    if (line.startsWith("bestmove ")) {
      this.finishActiveSearch(
        activeSearch.latestEvaluation ??
          new Error("Stockfish finished without reporting a score."),
      );
    }
  }

  private finishActiveSearch(result: Evaluation | Error) {
    const activeSearch = this.activeSearch;
    if (!activeSearch) return;

    clearTimeout(activeSearch.timeout);
    this.activeSearch = null;

    if (result instanceof Error) {
      activeSearch.reject(result);
    } else {
      if (isDev) {
        console.log(
          `[eval] searchId=${activeSearch.id} final:`,
          JSON.stringify(result),
        );
      }
      activeSearch.resolve(result);
    }
  }

  private cancelActiveSearch(message: string) {
    const activeSearch = this.activeSearch;
    if (!activeSearch) return;

    clearTimeout(activeSearch.timeout);
    this.activeSearch = null;
    activeSearch.reject(new Error(message));
  }

  private rejectAll(error: Error) {
    this.waiters.forEach((waiter) => {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    });
    this.waiters = [];
    this.cancelActiveSearch(error.message);
  }

  private send(command: string) {
    if (!this.process || this.process.killed) return;
    this.process.stdin.write(`${command}\n`);
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

  if (cpMatch) {
    return {
      type: "cp",
      value: Number(cpMatch[1]) * search.sideMultiplier,
      depth,
      fen: search.fen,
    };
  }

  if (mateMatch) {
    return {
      type: "mate",
      value: Number(mateMatch[1]) * search.sideMultiplier,
      depth,
      fen: search.fen,
    };
  }

  return null;
}

function getDepth(value: unknown) {
  const parsedDepth = Number(value ?? DEFAULT_DEPTH);

  if (!Number.isFinite(parsedDepth)) {
    return DEFAULT_DEPTH;
  }

  return Math.max(1, Math.min(MAX_DEPTH, Math.floor(parsedDepth)));
}

function getFenValidationError(fen: string) {
  const validation = validateFen(fen);

  return validation.ok ? null : validation.error ?? "Invalid FEN.";
}

const evaluator = new NativeStockfishEvaluator(process.env.STOCKFISH_PATH);
const port = Number(process.env.PORT ?? DEFAULT_PORT);

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method !== "GET" || requestUrl.pathname !== "/api/eval") {
    writeJson(response, 404, { error: "Not found" });
    return;
  }

  const fen = (requestUrl.searchParams.get("fen") ?? "").trim();
  const depth = getDepth(requestUrl.searchParams.get("depth"));

  if (!fen) {
    writeJson(response, 400, { error: "Missing required query parameter: fen" });
    return;
  }

  const fenValidationError = getFenValidationError(fen);

  if (fenValidationError) {
    writeJson(response, 400, { error: fenValidationError });
    return;
  }

  if (isDev) {
    console.log(`[eval] HTTP request: fen="${fen}" depth=${depth}`);
  }

  const onProgress = (evaluation: Evaluation) => {
    if (response.writableEnded) return;
    if (!response.headersSent) {
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });
    }
    response.write(JSON.stringify(evaluation) + "\n");
  };

  void evaluator
    .evaluate(fen, depth, onProgress)
    .then(() => {
      if (!response.writableEnded) {
        response.end();
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (isDev) {
        console.error(`[eval] HTTP error:`, message);
      }
      if (!response.headersSent) {
        writeJson(response, 503, { error: message });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
});

server.listen(port, () => {
  console.log(`Local Stockfish eval server listening on http://localhost:${port}`);
});
