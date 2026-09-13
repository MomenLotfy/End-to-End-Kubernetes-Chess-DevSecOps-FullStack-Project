import { useState } from "react";
import { useSettings } from "../contexts/SettingsContext";
import AuthModal from "./AuthModal";
import LeaderboardModal from "./LeaderboardModal";
import SettingsPanel from "./SettingsPanel";
import ProfileModal from "./ProfileModal";
import FriendsModal from "./FriendsModal";
import TournamentsModal from "./TournamentsModal";
import Button from "./ui/Button";
import Chip from "./ui/Chip";
import { Sparkle } from "./ui/Modal";

const TIME_CONTROLS = [
  { label: "3 min", minutes: 3 },
  { label: "5 min", minutes: 5 },
  { label: "10 min", minutes: 10 },
  { label: "No limit", minutes: null },
];

// ============================================================
// components/HomeScreen.js — الشاشة الرئيسية (Premium Chess Club)
// ============================================================
export default function HomeScreen({ user, token, onLogout, onAuthSuccess, onPlayLocal, onPlayOnline, onPlayAI }) {
  const { colors: C } = useSettings();
  const [showAuth, setShowAuth] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showFriends, setShowFriends] = useState(false);
  const [showTournaments, setShowTournaments] = useState(false);
  const [timeControl, setTimeControl] = useState(TIME_CONTROLS[3]);

  const iconBtn = {
    width: "38px", height: "38px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
    background: C.pnl, border: `1px solid ${C.pnlBd}`, color: C.txMut, cursor: "pointer", fontSize: "1rem",
  };

  const linkChip = {
    display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", cursor: "pointer",
    color: C.txMut, fontSize: "var(--fs-caption)", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
  };
  const linkIcon = {
    width: "46px", height: "46px", borderRadius: "var(--r-lg)", display: "flex", alignItems: "center", justifyContent: "center",
    background: C.pnl, border: `1px solid ${C.pnlBd}`, fontSize: "1.2rem", color: C.gold,
  };

  return (
    <div className="cm-screen" style={{ minHeight: "100vh", background: C.bgGradient || C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-ui)", gap: "28px", position: "relative", padding: "24px" }}>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSuccess={onAuthSuccess} />}
      {showLeaderboard && <LeaderboardModal onClose={() => setShowLeaderboard(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showProfile && <ProfileModal token={token} onClose={() => setShowProfile(false)} />}
      {showFriends && <FriendsModal token={token} onClose={() => setShowFriends(false)} />}
      {showTournaments && <TournamentsModal token={token} user={user} onClose={() => setShowTournaments(false)} />}

      <Sparkle style={{ bottom: "36px", right: "36px" }} />

      {/* top-right utility icons */}
      <div style={{ position: "fixed", top: "18px", right: "18px", display: "flex", gap: "10px", zIndex: 5 }}>
        <div className="cm-btn" style={iconBtn} onClick={() => setShowSettings(true)} title="Settings">⚙</div>
      </div>

      {/* top-left brand mark */}
      <div style={{ position: "fixed", top: "18px", left: "22px", display: "flex", alignItems: "center", gap: "8px", zIndex: 5 }}>
        <span style={{ fontSize: "1.3rem", color: C.gold }}>♞</span>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.95rem", color: C.tx, letterSpacing: "0.08em" }}>CHESS MASTER</span>
      </div>

      {/* hero card */}
      <div className="cm-card" style={{
        width: "100%", maxWidth: "440px", background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: "var(--r-xl)", padding: "36px 32px", display: "flex", flexDirection: "column",
        alignItems: "center", gap: "20px", boxShadow: `var(--sh-lg), 0 0 60px -20px ${C.goldSoft}`,
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-display)", fontWeight: 800, color: C.tx, letterSpacing: "0.02em", lineHeight: 1.05 }}>Start Your Match</div>
          <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.22em", marginTop: "6px", textTransform: "uppercase" }}>Premium Chess Club</div>
        </div>

        {user ? (
          <div style={{ color: C.tx, fontSize: "var(--fs-small)", textAlign: "center", padding: "8px 18px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-full)", display: "flex", alignItems: "center", gap: "12px" }}>
            <span onClick={() => setShowProfile(true)} style={{ cursor: "pointer", fontWeight: 600 }}>♟ {user.username}</span>
            <span onClick={() => setShowFriends(true)} style={{ color: C.txMut, cursor: "pointer" }}>Friends</span>
            <span onClick={onLogout} style={{ color: C.txMut, cursor: "pointer", textDecoration: "underline" }}>Logout</span>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setShowAuth(true)}>Sign In / Register</Button>
        )}

        <div style={{ width: "100%" }}>
          <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.14em", textTransform: "uppercase", textAlign: "center", marginBottom: "10px" }}>Time Control</div>
          <div style={{ display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap" }}>
            {TIME_CONTROLS.map(tc => (
              <Chip key={tc.label} active={timeControl.label === tc.label} onClick={() => setTimeControl(tc)}>{tc.label}</Chip>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", width: "100%", flexWrap: "wrap" }}>
          <Button variant="secondary" style={{ flex: 1, minWidth: "120px" }} onClick={onPlayAI}>Vs Computer</Button>
          <Button variant="primary" style={{ flex: 1, minWidth: "120px" }} onClick={() => onPlayLocal(timeControl.minutes)}>Play Local</Button>
          <Button variant="secondary" style={{ flex: 1, minWidth: "120px" }} onClick={onPlayOnline}>Play Online</Button>
        </div>
      </div>

      {/* quick links row */}
      <div style={{ display: "flex", gap: "20px" }}>
        <div style={linkChip} onClick={() => setShowLeaderboard(true)}><div style={linkIcon}>🏆</div>Leaderboard</div>
        <div style={linkChip} onClick={() => setShowTournaments(true)}><div style={linkIcon}>🏅</div>Tournaments</div>
        <div style={linkChip} onClick={() => user ? setShowFriends(true) : setShowAuth(true)}><div style={linkIcon}>👥</div>Friends</div>
      </div>

      {!user && <div style={{ fontSize: "var(--fs-caption)", color: C.txFaint, textAlign: "center", maxWidth: "260px" }}>Sign in to save your scores, climb the ELO leaderboard, and challenge friends.</div>}
    </div>
  );
}
