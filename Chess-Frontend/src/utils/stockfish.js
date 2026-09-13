// ============================================================
// utils/stockfish.js — تحميل وتشغيل محرك Stockfish (Chess AI + Move Hints)
//
// بيحمّل stockfish.js (نسخة asm.js/wasm خفيفة، بدون احتياج لـ
// SharedArrayBuffer أو CORS headers خاصة) من cdnjs وقت الحاجة بس،
// وبيشغّله جوه Web Worker عن طريق fetch + Blob (يتجنب مشاكل
// تحميل Worker من origin مختلف مباشرة).
// ============================================================
const ENGINE_URL = "https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js";

let workerPromise = null;

const loadWorker = async () => {
  const res = await fetch(ENGINE_URL);
  if (!res.ok) throw new Error("Couldn't download the chess engine (network/CDN issue)");
  const code = await res.text();
  const blob = new Blob([code], { type: "application/javascript" });
  const worker = new Worker(URL.createObjectURL(blob));

  // نستنى الجاهزية (uci → uciok، isready → readyok)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Engine init timed out")), 15000);
    const onMsg = (e) => {
      const line = e.data;
      if (line === "uciok") worker.postMessage("isready");
      if (line === "readyok") {
        clearTimeout(timeout);
        worker.removeEventListener("message", onMsg);
        resolve();
      }
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage("uci");
  });

  return worker;
};

// Singleton — نحمّل الـ worker مرة واحدة بس ونعيد استخدامه
export const getEngine = () => {
  if (!workerPromise) workerPromise = loadWorker();
  return workerPromise;
};

// بيرجع أفضل حركة لوضع (FEN) معين، بصيغة UCI ("e2e4", "e7e8q")
// skillLevel: 0 (أضعف) → 20 (أقوى، تقريبًا بدون أخطاء)
export const getBestMoveUci = async (fen, { skillLevel = 10, movetimeMs = 800 } = {}) => {
  const worker = await getEngine();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Engine move timed out")), movetimeMs + 10000);
    const onMsg = (e) => {
      const line = e.data;
      if (typeof line === "string" && line.startsWith("bestmove")) {
        clearTimeout(timeout);
        worker.removeEventListener("message", onMsg);
        const uci = line.split(" ")[1];
        resolve(uci === "(none)" ? null : uci);
      }
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage(`setoption name Skill Level value ${skillLevel}`);
    worker.postMessage("position fen " + fen);
    worker.postMessage(`go movetime ${movetimeMs}`);
  });
};

export const terminateEngine = () => {
  if (workerPromise) {
    workerPromise.then(w => w.terminate()).catch(() => {});
    workerPromise = null;
  }
};
