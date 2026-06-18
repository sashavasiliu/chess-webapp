export const STOCKFISH_WORKER_PATH = "/stockfish/stockfish-18-lite-single.js";
export const STOCKFISH_WASM_PATH = "/stockfish/stockfish-18-lite-single.wasm";
export const INIT_TIMEOUT_MS = 15_000;

export type Deferred<T> = {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export type AssetKind = "JavaScript" | "WASM";

export function looksLikeHtml(text: string) {
  const lowerText = text.toLowerCase();
  return (
    lowerText.startsWith("<!doctype html") ||
    lowerText.startsWith("<html") ||
    lowerText.includes("<title>") ||
    lowerText.includes("<body")
  );
}

export function hasWasmMagic(bytes: Uint8Array) {
  return bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
