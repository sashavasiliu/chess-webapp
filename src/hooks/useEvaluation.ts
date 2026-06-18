import { useEffect, useRef, useState } from "react";

export type Evaluation =
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

type EvaluationState = {
  evaluation: Evaluation | null;
  isLoading: boolean;
  isOffline: boolean;
};

const EVALUATION_DEBOUNCE_MS = 250;

function isEvaluation(value: unknown): value is Evaluation {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    (obj.type === "cp" || obj.type === "mate") &&
    typeof obj.value === "number" &&
    typeof obj.depth === "number" &&
    typeof obj.fen === "string"
  );
}

export function useEvaluation(fen: string, depth: number) {
  const [state, setState] = useState<EvaluationState>({
    evaluation: null,
    isLoading: false,
    isOffline: false,
  });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (import.meta.env.DEV) {
      console.log(`[eval] requestId=${requestId} FEN:`, fen);
    }

    const abortController = new AbortController();

    const loadingTimeoutId = window.setTimeout(() => {
      if (requestIdRef.current !== requestId) return;
      setState((currentState) => ({
        ...currentState,
        isLoading: true,
        isOffline: false,
      }));
    }, 0);

    const timeoutId = window.setTimeout(() => {
      const params = new URLSearchParams({ fen, depth: String(depth) });
      const url = `/api/eval?${params.toString()}`;

      if (import.meta.env.DEV) {
        console.log(`[eval] requestId=${requestId} fetching:`, url);
      }

      void (async () => {
        try {
          const response = await fetch(url, { signal: abortController.signal });

          if (!response.ok) {
            const errorBody = await response.json().catch(() => null);
            throw new Error(
              typeof errorBody?.error === "string"
                ? errorBody.error
                : `Evaluation request failed with ${response.status}`,
            );
          }

          if (!response.body) {
            throw new Error("Response body is not available.");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                let parsed: unknown;
                try {
                  parsed = JSON.parse(trimmed);
                } catch {
                  continue;
                }

                if (
                  typeof parsed === "object" &&
                  parsed !== null &&
                  "error" in parsed
                ) {
                  throw new Error(
                    String((parsed as Record<string, unknown>).error),
                  );
                }

                if (!isEvaluation(parsed)) continue;
                if (requestIdRef.current !== requestId) return;

                if (import.meta.env.DEV) {
                  console.log(
                    `[eval] requestId=${requestId} depth=${parsed.depth}:`,
                    parsed,
                  );
                }

                setState({ evaluation: parsed, isLoading: false, isOffline: false });
              }
            }
          } finally {
            void reader.cancel();
          }
        } catch (error: unknown) {
          if (requestIdRef.current !== requestId) return;
          if (error instanceof DOMException && error.name === "AbortError") return;

          if (import.meta.env.DEV) {
            console.warn(`[eval] requestId=${requestId} failed:`, error);
          }

          setState({ evaluation: null, isLoading: false, isOffline: true });
        }
      })();
    }, EVALUATION_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(loadingTimeoutId);
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [fen, depth]);

  return state;
}
