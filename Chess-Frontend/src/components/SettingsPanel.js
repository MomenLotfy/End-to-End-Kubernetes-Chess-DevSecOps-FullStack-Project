// src/components/SettingsPanel.js
import { useSettings } from "../contexts/SettingsContext";
import { APP_THEME_LIST } from "../constants/appThemes";
import { BOARD_THEME_LIST, BOARD_THEMES } from "../constants/boardThemes";
import { PIECE_STYLE_LIST } from "../constants/pieceStyles";
import Icon from "./ui/Icon";

// ============================================================
// components/SettingsPanel.js — المظهر والصوت
// تصميم "ورقة فاخرة" (parchment) مميّز — ثابت بصريًا سواء
// الوضع العام Dark أو Light، بزوايا مزخرفة زي منيو نادي شطرنج
// ============================================================
const PAPER = {
  bg: "#f3e9d2", surface: "#faf3e4", ink: "#3a2513", inkMut: "#7a5c3a",
  border: "rgba(90,58,26,0.22)", selected: "#5c3a1e", gold: "#9c6b2e",
};

export default function SettingsPanel({ onClose }) {
  const { mode, setMode, boardThemeKey, setBoardThemeKey, pieceStyleKey, setPieceStyleKey, soundOn, setSoundOn } = useSettings();

  const section = { background: PAPER.surface, border: `1px solid ${PAPER.border}`, borderRadius: "var(--r-md)", padding: "16px" };
  const label = { fontSize: "var(--fs-caption)", fontWeight: 700, letterSpacing: "0.12em", color: PAPER.inkMut, textTransform: "uppercase", marginBottom: "10px" };
  const pill = (active) => ({
    padding: "9px 18px", borderRadius: "var(--r-full)", cursor: "pointer", fontSize: "var(--fs-small)",
    fontWeight: 600, fontFamily: "var(--font-ui)",
    border: `1.5px solid ${active ? PAPER.selected : PAPER.border}`,
    background: active ? PAPER.selected : "transparent",
    color: active ? "#f3e9d2" : PAPER.inkMut,
    display: "inline-flex", alignItems: "center", gap: "8px",
    boxShadow: active ? "var(--sh-sm)" : "none",
  });
  const swatch = (hex) => <span style={{ width: "13px", height: "13px", borderRadius: "3px", background: hex, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.25)" }} />;

  return (
    <div className="cm-fade-in" style={{ position: "fixed", inset: 0, background: "rgba(20,12,4,0.78)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: "14px" }}>
      <div className="cm-modal-pop" style={{ position: "relative", background: PAPER.bg, border: `1px solid ${PAPER.border}`, borderRadius: "var(--r-lg)", padding: "30px", width: "420px", maxWidth: "94vw", maxHeight: "90vh", overflowY: "auto", boxShadow: "var(--sh-lg)" }}>
        {/* ornate corners */}
        {[{ top: 10, left: 10, bt: "none", br: "none" }, { top: 10, right: 10, bt: "none", bl: "none" }, { bottom: 10, left: 10, bb: "none", br: "none" }, { bottom: 10, right: 10, bb: "none", bl: "none" }].map((p, i) => (
          <div key={i} style={{ position: "absolute", width: "20px", height: "20px", border: `2px solid ${PAPER.gold}`, opacity: 0.6, borderTop: p.bt, borderBottom: p.bb, borderLeft: p.bl, borderRight: p.br, top: p.top, bottom: p.bottom, left: p.left, right: p.right, pointerEvents: "none" }} />
        ))}

        <div style={{ textAlign: "center", marginBottom: "22px" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-display)", fontWeight: 700, color: PAPER.ink, letterSpacing: "0.06em" }}>Settings</div>
          <div style={{ fontSize: "var(--fs-small)", color: PAPER.inkMut, marginTop: "4px" }}>Customize your game experience.</div>
        </div>

        <button onClick={onClose} style={{ position: "absolute", top: "18px", right: "18px", background: "transparent", border: "none", color: PAPER.inkMut, fontSize: "1.3rem", cursor: "pointer" }}><Icon name="back" size={24} /></button>

        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={section}>
            <div style={label}>Appearance</div>
            <div style={{ display: "flex", gap: "10px" }}>
              {APP_THEME_LIST.map(t => (
                <div key={t.key} className="cm-chip" style={{ ...pill(mode === t.key), flex: 1, justifyContent: "center" }} onClick={() => setMode(t.key)}>{t.name.toUpperCase()}</div>
              ))}
            </div>
          </div>

          <div style={section}>
            <div style={label}>Board Theme</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
              {BOARD_THEME_LIST.map(t => (
                <div key={t.key} className="cm-chip" style={pill(boardThemeKey === t.key)} onClick={() => setBoardThemeKey(t.key)}>
                  {t.name.toUpperCase()} {swatch(BOARD_THEMES[t.key].dk)}
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
            <div style={section}>
              <div style={label}>Piece Style</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {PIECE_STYLE_LIST.map(s => (
                  <div key={s.key} className="cm-chip" style={pill(pieceStyleKey === s.key)} onClick={() => setPieceStyleKey(s.key)}>{s.name.toUpperCase()} ♘</div>
                ))}
              </div>
            </div>
            <div style={section}>
              <div style={label}>Sound Effects</div>
              <div onClick={() => setSoundOn(!soundOn)} style={{
                display: "flex", alignItems: "center", borderRadius: "var(--r-full)", cursor: "pointer",
                background: soundOn ? "#c9a355" : "#e2d7bf", padding: "4px", position: "relative", height: "38px",
                border: `1px solid ${PAPER.border}`,
              }}>
                <div style={{ flex: 1, textAlign: "center", fontSize: "var(--fs-caption)", fontWeight: 700, color: soundOn ? "#4a3410" : PAPER.inkMut }}>ON</div>
                <div style={{ flex: 1, textAlign: "center", fontSize: "var(--fs-caption)", fontWeight: 700, color: !soundOn ? PAPER.ink : "#c9a355" }}>OFF</div>
                <div style={{
                  position: "absolute", top: "3px", bottom: "3px", width: "calc(50% - 3px)",
                  left: soundOn ? "3px" : "calc(50%)", transition: "left var(--dur-base) var(--ease)",
                  borderRadius: "var(--r-full)", background: `linear-gradient(180deg, ${PAPER.selected}, #3a2513)`,
                  boxShadow: "var(--sh-sm)",
                }} />
              </div>
            </div>
          </div>
        </div>

        <button onClick={onClose} className="cm-btn" style={{
          marginTop: "22px", width: "100%", padding: "13px", borderRadius: "var(--r-md)",
          background: `linear-gradient(180deg, #6b4423, #4a2f18)`, color: "#f3e9d2",
          border: "1.5px solid rgba(243,233,210,0.3)", fontWeight: 700, letterSpacing: "0.12em",
          fontSize: "var(--fs-small)", cursor: "pointer", boxShadow: "var(--sh-md)",
        }}>SAVE CHANGES</button>
      </div>
    </div>
  );
}
