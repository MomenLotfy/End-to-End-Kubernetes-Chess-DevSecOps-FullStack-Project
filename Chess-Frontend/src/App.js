import { useEffect, useState } from "react";
import { SettingsProvider } from "./contexts/SettingsContext";
import { getStoredUser, getStoredToken, storeAuth, clearAuth } from "./utils/authStorage";
import { refreshSession, logout as logoutRequest } from "./api/client";
import useChessGame from "./hooks/useChessGame";
import HomeScreen from "./components/HomeScreen";
import GameScreen from "./components/GameScreen";
import OnlinePlay from "./components/OnlinePlay";
import AIPlay from "./components/AIPlay";
import AccountAction from "./components/AccountAction";
import MeetTheCreator from "./components/MeetTheCreator";

// ============================================================
// App.js — Chess Frontend (Full-Stack Version)
// Chess Game + JWT Auth + Leaderboard → Chess Backend API
//
// ملف تركيب (composition) بس — كل المنطق موزّع على:
//   engine/     محرك الشطرنج (قواعد اللعبة) + Replay reconstruction
//   hooks/      useChessGame (حالة اللعبة محليًا) + useGameTimer + useMultiplayer (Socket.io)
//   api/        نداءات الـ backend
//   contexts/   SettingsContext (Dark/Light, Board Theme, Piece Style, Sound)
//   components/ الشاشات والعناصر المرئية
// ============================================================
function ChessApp() {
  const accountAction = ["/verify-email", "/reset-password"].includes(window.location.pathname);
  const [screen, setScreen] = useState("home"); // home | local | online
  const [timerMinutes, setTimerMinutes] = useState(null);
  const [user, setUser] = useState(getStoredUser);
  const [token, setToken] = useState(getStoredToken);
  const [sessionReady, setSessionReady] = useState(accountAction);

  useEffect(() => {
    if (accountAction) return;
    let active = true;
    refreshSession()
      .then(({ user: restoredUser }) => {
        if (!active) return;
        storeAuth(restoredUser);
        setUser(restoredUser);
        setToken(true);
      })
      .catch(() => {
        if (!active) return;
        clearAuth();
        setUser(null);
        setToken(false);
      })
      .finally(() => { if (active) setSessionReady(true); });
    return () => { active = false; };
  }, [accountAction]);

  const logout = async () => {
    try { await logoutRequest(); } catch (_) { /* Local logout still completes if the network is unavailable. */ }
    clearAuth(); setUser(null); setToken(null);
  };
  const onAuth = (u) => { setUser(u); setToken(getStoredToken()); };

  const game = useChessGame();

  const playLocal = (minutes) => { setTimerMinutes(minutes); setScreen("local"); game.reset(); };

  if (accountAction) return <AccountAction />;
  if (!sessionReady) return null;
  return (
    <>
      {screen === "home" && (
        <HomeScreen user={user} token={token} onLogout={logout} onAuthSuccess={onAuth} onPlayLocal={playLocal} onPlayOnline={() => setScreen("online")} onPlayAI={() => setScreen("ai")} />
      )}
      {screen === "local" && (
        <GameScreen user={user} game={game} timerMinutes={timerMinutes} onExit={() => setScreen("home")} />
      )}
      {screen === "online" && (
        <OnlinePlay user={user} token={token} onExit={() => setScreen("home")} />
      )}
      {screen === "ai" && (
        <AIPlay onExit={() => setScreen("home")} />
      )}
    </>
  );
}

function AppInner() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/meet-the-creator") return <MeetTheCreator />;
  return <ChessApp />;
}

export default function App() {
  return (
    <SettingsProvider>
      <AppInner />
    </SettingsProvider>
  );
}
