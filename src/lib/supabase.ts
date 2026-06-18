import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export type GameStatus = "active" | "completed";
export type GameMode = "stockfish";
export type GameResult = "white" | "black" | "draw" | "ongoing";
export type PlayerColor = "w" | "b";
export type GameEndReason =
  | "ongoing"
  | "checkmate"
  | "timeout"
  | "resignation"
  | "draw";

export type SavedGame = {
  id: string;
  user_id: string;
  mode: GameMode;
  status: GameStatus;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  result: GameResult;
  pgn: string;
  timeline: unknown;
  current_ply: number;
  opponent_depth: number;
  player_color: PlayerColor;
  time_control_label: string;
  base_seconds: number | null;
  increment_seconds: number;
  player_time_remaining_seconds: number | null;
  player_clock_started_at: string | null;
  end_reason: GameEndReason;
};

export type Preferences = {
  user_id: string;
  sound_enabled: boolean;
  default_opponent_depth: number;
  default_eval_depth: number;
};
