import { useEffect, useState } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { ACHIEVEMENT_INFO } from "../constants/achievements";

// ============================================================
// components/AchievementToast.js — إشعار فتح وسام جديد
// ============================================================
export default function AchievementToast({ keys, onDone }) {
  const { colors: C } = useSettings();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => { setVisible(false); onDone?.(); }, 4000);
    return () => clearTimeout(t);
  }, [keys, onDone]);

  if (!keys || keys.length === 0 || !visible) return null;

  return (
    <div style={{ position: "fixed", top: "20px", left: "50%", zIndex: 1000, display: "flex", flexDirection: "column", gap: "8px" }}>
      {keys.map(k => {
        const info = ACHIEVEMENT_INFO[k] || { name: k, icon: "🏅" };
        return (
          <div key={k} className="cm-toast" style={{ background: `linear-gradient(160deg, ${C.surfaceHover}, ${C.modalBg})`, border: `1px solid ${C.gold}`, borderRadius: "var(--r-md)", padding: "10px 20px", display: "flex", alignItems: "center", gap: "10px", boxShadow: `var(--sh-lg), 0 0 20px ${C.goldSoft}` }}>
            <span style={{ fontSize: "1.4rem" }}>{info.icon}</span>
            <div>
              <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.1em" }}>ACHIEVEMENT UNLOCKED</div>
              <div style={{ fontSize: "var(--fs-small)", color: C.gold, fontWeight: 700, fontFamily: "var(--font-display)" }}>{info.name}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
