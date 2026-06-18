import type { Evaluation } from "../hooks/useEvaluation";

type EvaluationBarProps = {
  evaluation: Evaluation | null;
  isLoading: boolean;
  isOffline: boolean;
  error: string | null;
  targetDepth: number;
};

const VISUAL_CP_LIMIT = 1000;

function getWhiteShare(evaluation: Evaluation | null) {
  if (!evaluation) return 0.5;

  if (evaluation.type === "mate") {
    return evaluation.value > 0 ? 0.97 : 0.03;
  }

  const clampedCp = Math.max(
    -VISUAL_CP_LIMIT,
    Math.min(VISUAL_CP_LIMIT, evaluation.value),
  );

  return 1 / (1 + Math.exp(-clampedCp / 250));
}

function formatEvaluation(evaluation: Evaluation | null) {
  if (!evaluation) return "0.0";

  if (evaluation.type === "mate") {
    return evaluation.value > 0 ? `M${evaluation.value}` : `-M${Math.abs(evaluation.value)}`;
  }

  const pawns = evaluation.value / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(1)}`;
}

function formatDepthLabel(
  evaluation: Evaluation | null,
  isLoading: boolean,
  isOffline: boolean,
  targetDepth: number,
) {
  if (isOffline) return "Unavailable";
  if (!evaluation) return `Depth ${targetDepth}`;
  if (isLoading && evaluation.depth < targetDepth) {
    return `Depth ${evaluation.depth} / ${targetDepth}`;
  }

  return `Depth ${evaluation.depth}`;
}

export function EvaluationBar({
  evaluation,
  isLoading,
  isOffline,
  error,
  targetDepth,
}: EvaluationBarProps) {
  const whiteShare = getWhiteShare(isOffline ? null : evaluation);
  const depthText = formatDepthLabel(
    evaluation,
    isLoading,
    isOffline,
    targetDepth,
  );

  return (
    <div
      className="evaluation-stack"
      aria-label={error ? `Eval Bar failed: ${error}` : `Eval Bar, ${depthText}`}
      title={error ?? undefined}
    >
      <div className="evaluation-bar" aria-hidden="true">
        <div
          className="evaluation-bar-white"
          style={{ height: `${whiteShare * 100}%` }}
        />
        <div className="evaluation-value">{formatEvaluation(isOffline ? null : evaluation)}</div>
      </div>
      <div className="evaluation-status" aria-live="polite">
        <span>Eval Bar</span>
        <span>{depthText}</span>
      </div>
    </div>
  );
}
