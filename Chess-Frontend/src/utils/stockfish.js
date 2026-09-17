const ENGINE_SCRIPT = "/stockfish/stockfish.js";
let enginePromise = null;
let scriptPromise = null;

function loadScript() {
  if (window.Stockfish) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ENGINE_SCRIPT;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load the self-hosted chess engine"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

async function loadEngine() {
  await loadScript();
  if (typeof window.Stockfish !== "function") throw new Error("Chess engine initialization failed");
  const engine = await window.Stockfish();
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Engine init timed out")), 15000);
    const listener = line => {
      if (line === "uciok") engine.postMessage("isready");
      if (line === "readyok") {
        window.clearTimeout(timeout);
        engine.removeMessageListener(listener);
        resolve();
      }
    };
    engine.addMessageListener(listener);
    engine.postMessage("uci");
  });
  return engine;
}

export const getEngine = () => {
  if (!enginePromise) enginePromise = loadEngine();
  return enginePromise;
};

export async function getBestMoveUci(fen, { skillLevel = 10, movetimeMs = 800 } = {}) {
  const engine = await getEngine();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      engine.removeMessageListener(listener);
      engine.postMessage("stop");
      reject(new Error("Engine move timed out"));
    }, movetimeMs + 10000);
    const listener = line => {
      if (typeof line === "string" && line.startsWith("bestmove")) {
        window.clearTimeout(timeout);
        engine.removeMessageListener(listener);
        const uci = line.split(" ")[1];
        resolve(uci === "(none)" ? null : uci);
      }
    };
    engine.addMessageListener(listener);
    engine.postMessage(`setoption name Skill Level value ${Math.max(0, Math.min(20, skillLevel))}`);
    engine.postMessage(`position fen ${fen}`);
    engine.postMessage(`go movetime ${Math.max(50, movetimeMs)}`);
  });
}

export function terminateEngine() {
  if (enginePromise) enginePromise.then(engine => engine.postMessage("quit")).catch(() => {});
  enginePromise = null;
}
