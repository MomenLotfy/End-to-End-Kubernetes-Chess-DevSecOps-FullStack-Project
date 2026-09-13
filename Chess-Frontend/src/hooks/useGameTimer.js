import { useState, useEffect, useRef } from "react";

// ============================================================
// hooks/useGameTimer.js — عداد وقت لكل لاعب (Move Timer)
// minutes=null يعني "بدون وقت" (unlimited) فالعداد بيتوقف
// ============================================================
export default function useGameTimer({ minutes, turn, isRunning, onTimeout }) {
  const totalSeconds = minutes ? minutes * 60 : null;
  const [time, setTime] = useState({ w: totalSeconds, b: totalSeconds });
  const timeoutFired = useRef(false);

  // إعادة ضبط العداد لما وقت اللعبة (minutes) يتغيّر (لعبة جديدة)
  useEffect(() => {
    setTime({ w: totalSeconds, b: totalSeconds });
    timeoutFired.current = false;
  }, [totalSeconds]);

  useEffect(() => {
    if (!isRunning || totalSeconds === null) return;
    const interval = setInterval(() => {
      setTime(prev => {
        const next = { ...prev, [turn]: Math.max(0, prev[turn] - 1) };
        if (next[turn] === 0 && !timeoutFired.current) {
          timeoutFired.current = true;
          onTimeout?.(turn);
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, turn, totalSeconds, onTimeout]);

  const format = (s) => {
    if (s === null) return "∞";
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  return { white: format(time.w), black: format(time.b), lowW: totalSeconds && time.w <= 30, lowB: totalSeconds && time.b <= 30 };
}
