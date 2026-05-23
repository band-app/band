let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

export type SoundId =
  | "chime"
  | "bell"
  | "ping"
  | "drop"
  | "ripple"
  | "blip"
  | "horn"
  | "marimba"
  | "chirp"
  | "gong";

export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: "chime", label: "Chime" },
  { id: "bell", label: "Bell" },
  { id: "ping", label: "Ping" },
  { id: "drop", label: "Drop" },
  { id: "ripple", label: "Ripple" },
  { id: "blip", label: "Blip" },
  { id: "horn", label: "Horn" },
  { id: "marimba", label: "Marimba" },
  { id: "chirp", label: "Chirp" },
  { id: "gong", label: "Gong" },
];

function playTone(
  ctx: AudioContext,
  freq: number,
  start: number,
  duration: number,
  volume: number,
  type: OscillatorType = "sine",
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration);
}

function playChime() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(ctx, 660, now, 0.12, 0.3);
  playTone(ctx, 880, now + 0.2, 0.12, 0.3);
}

function playBell() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(ctx, 830, now, 0.6, 0.25);
  playTone(ctx, 1245, now, 0.4, 0.1);
  playTone(ctx, 1660, now, 0.2, 0.05);
}

function playPing() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(ctx, 1200, now, 0.15, 0.25);
}

function playDrop() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(800, now);
  osc.frequency.exponentialRampToValueAtTime(300, now + 0.3);
  gain.gain.setValueAtTime(0.3, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.3);
}

function playRipple() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const notes = [523, 659, 784, 1047];
  notes.forEach((freq, i) => {
    playTone(ctx, freq, now + i * 0.08, 0.15, 0.2);
  });
}

function playBlip() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(ctx, 440, now, 0.06, 0.25, "square");
  playTone(ctx, 660, now + 0.08, 0.06, 0.25, "square");
}

function playHorn() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(ctx, 440, now, 0.3, 0.2, "sawtooth");
  playTone(ctx, 554, now + 0.05, 0.25, 0.15, "sawtooth");
}

function playMarimba() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(ctx, 523, now, 0.2, 0.3, "triangle");
  playTone(ctx, 659, now + 0.15, 0.2, 0.25, "triangle");
  playTone(ctx, 784, now + 0.3, 0.25, 0.2, "triangle");
}

function playChirp() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(400, now);
  osc.frequency.exponentialRampToValueAtTime(1600, now + 0.1);
  osc.frequency.exponentialRampToValueAtTime(400, now + 0.2);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.25, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.2);
}

function playGong() {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  playTone(ctx, 220, now, 1.0, 0.25);
  playTone(ctx, 330, now, 0.6, 0.1);
  playTone(ctx, 440, now, 0.3, 0.05, "triangle");
}

const players: Record<SoundId, () => void> = {
  chime: playChime,
  bell: playBell,
  ping: playPing,
  drop: playDrop,
  ripple: playRipple,
  blip: playBlip,
  horn: playHorn,
  marimba: playMarimba,
  chirp: playChirp,
  gong: playGong,
};

export function playSound(id: SoundId) {
  players[id]();
}
