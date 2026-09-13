import { useState } from "react";
import { SettingsProvider } from "./contexts/SettingsContext";
import { getStoredUser, getStoredToken, clearAuth } from "./utils/authStorage";
import { saveScore } from "./api/client";
import useChessGame from "./hooks/useChessGame";
import HomeScreen from "./components/HomeScreen";
import GameScreen from "./components/GameScreen";
import OnlinePlay from "./components/OnlinePlay";
import AIPlay from "./components/AIPlay";
import AchievementToast from "./components/AchievementToast";

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
function AppInner() {
  const [screen, setScreen] = useState("home"); // home | local | online
  const [timerMinutes, setTimerMinutes] = useState(null);
  const [user, setUser] = useState(getStoredUser);
  const [token, setToken] = useState(getStoredToken);
  const [newAchievements, setNewAchievements] = useState([]);

  const logout = () => { clearAuth(); setUser(null); setToken(null); };
  const onAuth = (u) => { setUser(u); setToken(getStoredToken()); };

  const game = useChessGame({
    onGameFinished: async ({ moveCount, duration, winner, moveHistory }) => {
      const result = await saveScore(token, { moves: moveCount, duration, winner, moveHistory });
      if (result?.newAchievements?.length) setNewAchievements(result.newAchievements);
    },
  });

  const playLocal = (minutes) => { setTimerMinutes(minutes); setScreen("local"); game.reset(); };

  return (
    <>
      <AchievementToast keys={newAchievements} onDone={() => setNewAchievements([])} />
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
        <AIPlay token={token} onExit={() => setScreen("home")} />
      )}
    </>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <AppInner />
    </SettingsProvider>
  );
}
