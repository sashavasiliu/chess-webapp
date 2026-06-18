import { useEffect, useRef, useState } from "react";
import { EvaluationEngine, type Evaluation } from "../evaluationEngine";

export type { Evaluation };

type EvaluationState = {
  evaluation: Evaluation | null;
  isLoading: boolean;
  isOffline: boolean;
  error: string | null;
};

const EVALUATION_DEBOUNCE_MS = 250;

export function useEvaluation(fen: string, depth: number, enabled = true) {
  const [state, setState] = useState<EvaluationState>({
    evaluation: null,
    isLoading: false,
    isOffline: false,
    error: null,
  });
  const requestIdRef = useRef(0);
  const engineRef = useRef<EvaluationEngine | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const engine = new EvaluationEngine();
    engineRef.current = engine;

    return () => {
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
      engine.quit();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      requestIdRef.current += 1;
      engineRef.current?.stop("Evaluation disabled.");
      const timeoutId = window.setTimeout(() => {
        setState({
          evaluation: null,
          isLoading: false,
          isOffline: false,
          error: null,
        });
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (import.meta.env.DEV) {
      console.log(`[eval] requestId=${requestId} FEN:`, fen);
    }

    const loadingTimeoutId = window.setTimeout(() => {
      if (requestIdRef.current !== requestId) return;
      setState((currentState) => ({
        ...currentState,
        isLoading: true,
        isOffline: false,
        error: null,
      }));
    }, 0);

    const timeoutId = window.setTimeout(() => {
      if (import.meta.env.DEV) {
        console.log(`[eval] requestId=${requestId} analyzing in browser`);
      }

      void (async () => {
        try {
          const engine = engineRef.current;

          if (!engine) {
            throw new Error("Evaluation engine has not been created yet.");
          }

          await engine.evaluate(fen, depth, (evaluation) => {
            if (requestIdRef.current !== requestId) return;

            if (import.meta.env.DEV) {
              console.log(
                `[eval] requestId=${requestId} depth=${evaluation.depth}:`,
                evaluation,
              );
            }

            setState({
              evaluation,
              isLoading: false,
              isOffline: false,
              error: null,
            });
          });
        } catch (error: unknown) {
          if (requestIdRef.current !== requestId) return;

          if (
            error instanceof Error &&
            error.message.includes("interrupted by a newer request")
          ) {
            return;
          }

          if (import.meta.env.DEV) {
            console.warn(`[eval] requestId=${requestId} failed:`, error);
          }

          setState({
            evaluation: null,
            isLoading: false,
            isOffline: true,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, EVALUATION_DEBOUNCE_MS);

    return () => {
      if (requestIdRef.current === requestId) {
        requestIdRef.current += 1;
      }
      window.clearTimeout(loadingTimeoutId);
      window.clearTimeout(timeoutId);
      engineRef.current?.stop("Evaluation interrupted by a newer request.");
    };
  }, [fen, depth, enabled]);

  return state;
}
