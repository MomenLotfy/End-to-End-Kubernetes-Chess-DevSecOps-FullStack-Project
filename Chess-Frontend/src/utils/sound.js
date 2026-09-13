// ============================================================
// utils/sound.js — مؤثرات صوتية (Sound Effects)
// بيتولد صوتها عن طريق Web Audio API (بدون ملفات صوت خارجية)
// ============================================================
let ctx = null;
const getCtx = () => {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
};

const tone = (freq, duration, { type = "sine", gain = 0.12, delay = 0 } = {}) => {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const start = audioCtx.currentTime + delay;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(g); g.connect(audioCtx.destination);
  osc.start(start); osc.stop(start + duration + 0.02);
};

const SOUNDS = {
  move:      () => tone(440, 0.08, { type: "sine" }),
  capture:   () => tone(280, 0.12, { type: "square", gain: 0.1 }),
  check:     () => { tone(660, 0.1, { type: "triangle" }); tone(880, 0.12, { type: "triangle", delay: 0.08 }); },
  checkmate: () => { tone(520, 0.15, { type: "sawtooth", gain: 0.1 }); tone(390, 0.18, { type: "sawtooth", gain: 0.1, delay: 0.14 }); tone(260, 0.25, { type: "sawtooth", gain: 0.1, delay: 0.28 }); },
  gameEnd:   () => { tone(392, 0.15, { type: "triangle" }); tone(523, 0.2, { type: "triangle", delay: 0.14 }); },
};

// enabled بيتبعت من الـ Settings (soundOn) — لو false مفيش صوت خالص
export const playSound = (name, enabled) => {
  if (!enabled) return;
  try { SOUNDS[name]?.(); } catch { /* WebAudio مش متاح - نتجاهل بهدوء */ }
};
