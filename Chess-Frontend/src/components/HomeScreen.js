// src/components/HomeScreen.js
import { useState } from "react";
import { useSettings } from "../contexts/SettingsContext";
import AuthModal from "./AuthModal";
import LeaderboardModal from "./LeaderboardModal";
import SettingsPanel from "./SettingsPanel";
import ProfileModal from "./ProfileModal";
import FriendsModal from "./FriendsModal";
import TournamentsModal from "./TournamentsModal";
import Button from "./ui/Button";
import Icon from "./ui/Icon";
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
  return (
    <div className="cm-screen" style={{ minHeight: "100vh", background: C.bgGradient || C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-ui)", gap: "28px", position: "relative", padding: "24px" }}>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSuccess={onAuthSuccess} />}
      {showLeaderboard && <LeaderboardModal onClose={() => setShowLeaderboard(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showProfile && <ProfileModal token={token} onClose={() => setShowProfile(false)} />}
      {showFriends && <FriendsModal token={token} onClose={() => setShowFriends(false)} />}
      {showTournaments && <TournamentsModal token={token} user={user} onClose={() => setShowTournaments(false)} />}

      <Sparkle style={{ bottom: "36px", right: "36px" }} />

      <div style={{ position: "fixed", top: "18px", right: "18px", display: "flex", gap: "10px", zIndex: 5 }}>
        {user ? (
          <>
            <div className="cm-btn" style={iconBtn} onClick={() => setShowProfile(true)} title="Profile"><Icon name="profile" size={24} /></div>
            <div className="cm-btn" style={iconBtn} onClick={() => setShowFriends(true)} title="Friends"><Icon name="friends" size={24} /></div>
            <div className="cm-btn" style={iconBtn} onClick={onLogout} title="Logout"><Icon name="logout" size={24} /></div>
          </>
        ) : (
          <div className="cm-btn" style={iconBtn} onClick={() => setShowAuth(true)} title="Sign In / Register"><Icon name="login" size={24} /></div>
        )}
        <div className="cm-btn" style={iconBtn} onClick={() => setShowSettings(true)} title="Settings"><Icon name="chess-strategy" size={24} /></div>
      </div>

      {/* top-left brand mark */}
      <div style={{ position: "fixed", top: "18px", left: "22px", display: "flex", alignItems: "center", gap: "8px", zIndex: 5 }}>
        <span style={{ fontSize: "1.3rem", color: C.gold }}><Icon name="chess-logo" size={72} /></span>
        <span className="cm-brand-text" style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.95rem", color: C.tx, letterSpacing: "0.08em" }}>CHESS MASTER</span>
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

        {/* Auth/Profile moved to navbar */}

        <div style={{ width: "100%" }}>
          <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.14em", textTransform: "uppercase", textAlign: "center", marginBottom: "10px" }}>Time Control</div>
          <div style={{ display: "flex", gap: "8px", justifyContent: "center", flexWrap: "wrap" }}>
            {TIME_CONTROLS.map(tc => (
              <Chip key={tc.label} active={timeControl.label === tc.label} onClick={() => setTimeControl(tc)}>{tc.label}</Chip>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", width: "100%", flexWrap: "wrap" }}>
          <Button variant="secondary" style={{ flex: 1, minWidth: "120px", display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }} onClick={onPlayAI}><Icon name="chess" size={24} />Vs Computer</Button>
          <Button variant="primary" style={{ flex: 1, minWidth: "120px", display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }} onClick={() => onPlayLocal(timeControl.minutes)}><Icon name="chess" size={24} />Play Local</Button>
          <Button variant="secondary" style={{ flex: 1, minWidth: "120px", display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }} onClick={() => user ? onPlayOnline() : setShowAuth(true)}><Icon name="online-chess" size={24} />Play Online</Button>
        </div>
      </div>

      {/* quick links row */}
      <div style={{ display: "flex", gap: "20px", flexWrap: "wrap", justifyContent: "center" }}>
        <div style={linkChip} onClick={() => setShowLeaderboard(true)}><Icon name="chess-cup" size={46} />Leaderboard</div>
        <div style={linkChip} onClick={() => setShowTournaments(true)}><Icon name="knock-out-stage" size={46} />Tournaments</div>
        <div style={linkChip} onClick={() => user ? setShowFriends(true) : setShowAuth(true)}><Icon name="friends" size={46} />Friends</div>
        <a href="/meet-the-creator" style={{ ...linkChip, textDecoration: "none" }}><Icon name="profile" size={46} />Meet the Creator</a>
      </div>

      {!user && <div style={{ fontSize: "var(--fs-caption)", color: C.txFaint, textAlign: "center", maxWidth: "260px" }}>Sign in to save your scores, climb the ELO leaderboard, and challenge friends.</div>}
    </div>
  );
}
