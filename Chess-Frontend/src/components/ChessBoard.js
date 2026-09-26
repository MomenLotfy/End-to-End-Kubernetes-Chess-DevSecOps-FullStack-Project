import { FILES } from "../constants/pieces";
import { useSettings } from "../contexts/SettingsContext";
import PieceGlyph from "./ui/PieceGlyph";

const SZ = 60; // desktop square size; actual rendering is fluid via --sq (see index.css)
const SQ = "var(--sq)";
const SQLABEL = "var(--sq-label)";
const COORDFS = "var(--sq-coord-fs)";

// ============================================================
// components/ChessBoard.js — رقعة الشطرنج 8×8 (Premium Chess Club)
// ============================================================
export default function ChessBoard({ board, sel, mvSet, lastMv, ckKing, onSquareClick, hint }) {
  const { colors: C } = useSettings();

  const getBg = (r, c) => {
    const lt = (r + c) % 2 === 0;
    const isSel = sel && sel[0] === r && sel[1] === c;
    const isLast = lastMv && ((lastMv[0] === r && lastMv[1] === c) || (lastMv[2] === r && lastMv[3] === c));
    if (isSel) return lt ? C.selLt : C.selDk;
    if (isLast) return lt ? C.lastLt : C.lastDk;
    return lt ? C.lt : C.dk;
  };

  return (
    <div style={{
      background: `linear-gradient(155deg, ${C.wood}, ${C.woodDk})`,
      padding: "10px", borderRadius: "var(--r-lg)",
      boxShadow: "var(--sh-lg), inset 0 1px 0 rgba(255,255,255,0.06)",
      border: `1px solid ${C.woodBd}`,
    }}>
      <div style={{ background: C.woodDk, padding: "3px", borderRadius: "var(--r-md)", boxShadow: "var(--sh-inset)" }}>
        <div style={{ display: "flex" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {[0, 1, 2, 3, 4, 5, 6, 7].map(r => (
              <div key={r} style={{ width: SQLABEL, height: SQ, display: "flex", alignItems: "center", justifyContent: "center", fontSize: COORDFS, fontWeight: 700, fontFamily: "var(--font-ui)", color: r % 2 === 0 ? C.dk : C.lt, userSelect: "none" }}>{8 - r}</div>
            ))}
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              {FILES.map((f, i) => <div key={f} style={{ width: SQ, height: SQLABEL, display: "flex", alignItems: "center", justifyContent: "center", fontSize: COORDFS, fontWeight: 700, fontFamily: "var(--font-ui)", color: i % 2 === 0 ? C.dk : C.lt, userSelect: "none" }}>{f}</div>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(8,${SQ})`, gridTemplateRows: `repeat(8,${SQ})`, borderRadius: "3px", overflow: "hidden", boxShadow: "0 0 0 1px rgba(0,0,0,0.4)" }}>
              {[0, 1, 2, 3, 4, 5, 6, 7].map(r => [0, 1, 2, 3, 4, 5, 6, 7].map(c => {
                const p = board[r][c], isT = mvSet.has(`${r},${c}`), hasP = !!p, isSel = sel && sel[0] === r && sel[1] === c;
                const isCk = ckKing === `${r},${c}`;
                const isHint = hint && ((hint.from[0] === r && hint.from[1] === c) || (hint.to[0] === r && hint.to[1] === c));
                return (
                  <div key={`${r}-${c}`} onClick={() => onSquareClick(r, c)}
                    className={`cm-square ${isCk ? "cm-check-pulse" : ""}`}
                    style={{ width: SQ, height: SQ, background: getBg(r, c), display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", position: "relative", userSelect: "none" }}>
                    {isCk && (
                      <div style={{ position: "absolute", top: 3, right: 3, width: "max(10px, calc(var(--sq) * 0.22))", height: "max(10px, calc(var(--sq) * 0.22))", borderRadius: "50%", background: C.danger, boxShadow: "0 0 6px rgba(209,85,79,0.9)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "9px", color: "#fff", zIndex: 4 }}>✦</div>
                    )}
                    {isHint && <div className="cm-hint-ring" style={{ position: "absolute", inset: "4px", border: `3px dashed ${C.gold}`, borderRadius: "6px", pointerEvents: "none", zIndex: 3 }} />}
                    {isT && !hasP && <div className="cm-hint-ring" style={{ width: "calc(var(--sq) * 0.3)", height: "calc(var(--sq) * 0.3)", borderRadius: "50%", background: "rgba(0,0,0,0.24)", boxShadow: "inset 0 1px 2px rgba(255,255,255,0.15)", position: "absolute", pointerEvents: "none" }} />}
                    {isT && hasP && <div className="cm-hint-ring" style={{ width: "calc(var(--sq) - 6px)", height: "calc(var(--sq) - 6px)", borderRadius: "50%", border: `4px solid ${C.danger}88`, position: "absolute", pointerEvents: "none" }} />}
                    {p && (
                      <span key={`${r}-${c}-${p}`} className="cm-piece" style={{ display: "inline-flex", transform: isSel ? "scale(1.08) translateY(-1px)" : "scale(1)", filter: isSel ? `drop-shadow(0 0 6px ${C.goldSoft})` : "none", transition: "transform var(--dur-fast) var(--ease)" }}>
                        <PieceGlyph piece={p} size="calc(var(--sq) * 0.8)" />
                      </span>
                    )}
                  </div>
                );
              }))}
            </div>
            <div style={{ display: "flex" }}>
              {FILES.map((f, i) => <div key={f} style={{ width: SQ, height: SQLABEL, display: "flex", alignItems: "center", justifyContent: "center", fontSize: COORDFS, fontWeight: 700, fontFamily: "var(--font-ui)", color: i % 2 === 0 ? C.dk : C.lt, userSelect: "none" }}>{f}</div>)}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {[0, 1, 2, 3, 4, 5, 6, 7].map(r => (
              <div key={r} style={{ width: SQLABEL, height: SQ, display: "flex", alignItems: "center", justifyContent: "center", fontSize: COORDFS, fontWeight: 700, fontFamily: "var(--font-ui)", color: r % 2 === 0 ? C.dk : C.lt, userSelect: "none" }}>{8 - r}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export { SZ };
