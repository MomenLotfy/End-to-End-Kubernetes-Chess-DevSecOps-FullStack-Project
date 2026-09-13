import { createContext, useContext, useState, useMemo, useCallback, useEffect } from "react";
import { APP_THEMES } from "../constants/appThemes";
import { BOARD_THEMES } from "../constants/boardThemes";
import { PIECE_STYLES } from "../constants/pieceStyles";
import { playSound } from "../utils/sound";

// ============================================================
// contexts/SettingsContext.js — إعدادات المستخدم للمظهر والصوت
// (Dark/Light Mode + Board Themes + Piece Styles + Sound Effects)
// كل حاجة متخزنة في localStorage عشان تفضل زي ما هي بين الزيارات
// ============================================================
const STORAGE_KEY = "chess_settings";

const loadSettings = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      mode:          saved?.mode          || "dark",
      boardThemeKey: saved?.boardThemeKey || "classic",
      pieceStyleKey: saved?.pieceStyleKey || "classic",
      soundOn:       saved?.soundOn ?? true,
    };
  } catch {
    return { mode: "dark", boardThemeKey: "classic", pieceStyleKey: "classic", soundOn: true };
  }
};

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(loadSettings);

  const persist = useCallback((next) => {
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const setMode          = (mode)          => persist({ ...settings, mode });
  const setBoardThemeKey = (boardThemeKey) => persist({ ...settings, boardThemeKey });
  const setPieceStyleKey = (pieceStyleKey) => persist({ ...settings, pieceStyleKey });
  const setSoundOn       = (soundOn)       => persist({ ...settings, soundOn });

  const appTheme   = APP_THEMES[settings.mode]                    || APP_THEMES.dark;
  const boardTheme = BOARD_THEMES[settings.boardThemeKey]         || BOARD_THEMES.classic;
  const pieceStyle = PIECE_STYLES[settings.pieceStyleKey]         || PIECE_STYLES.classic;

  // نفس شكل الـ "C" اللي الكومبوننتس كانت بتستخدمه، بس دلوقتي ديناميكي
  const colors = useMemo(() => ({ ...appTheme, ...boardTheme }), [appTheme, boardTheme]);

  // نحدّث خلفية الصفحة نفسها (body) مع تغيير الثيم عشان مفيش "ومضة" لون قديم
  useEffect(() => {
    document.body.style.background = appTheme.bgGradient || appTheme.bg;
  }, [appTheme.bgGradient, appTheme.bg]);

  const value = {
    ...settings,
    setMode, setBoardThemeKey, setPieceStyleKey, setSoundOn,
    colors,
    pieceSymbols: pieceStyle.symbols,
    playSound: (name) => playSound(name, settings.soundOn),
  };

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
};
