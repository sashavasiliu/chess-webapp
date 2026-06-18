export type ChessSoundEvent = "move" | "capture" | "promote" | "check" | "checkmate";

const CHESS_SOUND_VOLUME = 0.5;
const SOUND_ENABLED_STORAGE_KEY = "chess.sound.enabled";

const SOUND_VARIANTS: Record<ChessSoundEvent, string[]> = {
  move: [
    "/sounds/move1.mp3",
    "/sounds/move2.mp3",
    "/sounds/move3.mp3",
    "/sounds/move4.mp3",
  ],
  capture: ["/sounds/capture1.mp3", "/sounds/capture2.mp3"],
  check: ["/sounds/check.mp3"],
  promote: [
    "/sounds/move1.mp3",
    "/sounds/move2.mp3",
    "/sounds/move3.mp3",
    "/sounds/move4.mp3",
  ],
  checkmate: ["/sounds/check.mp3"],
};

const sounds = new Map<string, HTMLAudioElement>();
const warnedSounds = new Set<string>();
const lastVariantByEvent = new Map<ChessSoundEvent, string>();

let hasUnlockedAudio = false;
let soundEnabled = readSavedSoundPreference();

function isBrowser() {
  return typeof window !== "undefined" && typeof Audio !== "undefined";
}

function warnMissingSound(path: string) {
  if (!import.meta.env.DEV || warnedSounds.has(path)) return;

  warnedSounds.add(path);
  console.warn(`Chess sound could not be loaded: ${path}`);
}

function readSavedSoundPreference() {
  if (typeof window === "undefined") return true;

  try {
    return window.localStorage.getItem(SOUND_ENABLED_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function getAudio(path: string) {
  if (!isBrowser()) return null;

  const existingAudio = sounds.get(path);
  if (existingAudio) return existingAudio;

  const audio = new Audio(path);
  audio.preload = "auto";
  audio.volume = CHESS_SOUND_VOLUME;
  audio.addEventListener("error", () => warnMissingSound(path));
  audio.load();

  sounds.set(path, audio);
  return audio;
}

function getAllSoundPaths() {
  return [...new Set(Object.values(SOUND_VARIANTS).flat())];
}

function chooseVariant(eventType: ChessSoundEvent) {
  const variants = SOUND_VARIANTS[eventType];

  if (variants.length < 2) {
    return variants[0];
  }

  const previousVariant = lastVariantByEvent.get(eventType);
  const availableVariants = previousVariant
    ? variants.filter((variant) => variant !== previousVariant)
    : variants;
  const variant =
    availableVariants[Math.floor(Math.random() * availableVariants.length)] ?? variants[0];

  lastVariantByEvent.set(eventType, variant);
  return variant;
}

export function preloadChessSounds() {
  getAllSoundPaths().forEach((path) => {
    getAudio(path);
  });
}

export function unlockAudio() {
  if (hasUnlockedAudio) return;

  hasUnlockedAudio = true;
  preloadChessSounds();

  sounds.forEach((audio) => {
    const wasMuted = audio.muted;
    audio.muted = true;

    try {
      audio.currentTime = 0;
      const playPromise = audio.play();

      if (playPromise) {
        void playPromise
          .then(() => {
            audio.pause();
            audio.currentTime = 0;
            audio.muted = wasMuted;
          })
          .catch(() => {
            audio.muted = wasMuted;
          });
      } else {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = wasMuted;
      }
    } catch {
      audio.muted = wasMuted;
    }
  });
}

export function isChessSoundEnabled() {
  return soundEnabled;
}

export function setChessSoundEnabled(enabled: boolean) {
  soundEnabled = enabled;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SOUND_ENABLED_STORAGE_KEY, enabled ? "on" : "off");
    } catch {
      // Sound can still work for the current session if preference storage is blocked.
    }
  }

  if (enabled) {
    preloadChessSounds();
  }
}

export function playChessSound(eventType: ChessSoundEvent) {
  if (!soundEnabled) return;

  const path = chooseVariant(eventType);
  const audio = getAudio(path);
  if (!audio) return;

  try {
    audio.volume = CHESS_SOUND_VOLUME;
    audio.currentTime = 0;
    const playPromise = audio.play();

    if (playPromise) {
      void playPromise.catch(() => {
        // Browser autoplay policy can reject until the first user gesture.
      });
    }
  } catch {
    // Keep gameplay silent instead of surfacing media playback failures.
  }
}

preloadChessSounds();
