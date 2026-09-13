import { useState } from "react";
import { useSettings } from "../contexts/SettingsContext";
import useMultiplayer from "../hooks/useMultiplayer";
import ChessBoard from "./ChessBoard";
import CapturedPieces from "./CapturedPieces";
import PromotionModal from "./PromotionModal";
import ChatPanel from "./ChatPanel";
import Button from "./ui/Button";

// ============================================================
// components/OnlinePlay.js — Multiplayer حقيقي: Lobby + اللعب + الشات
// ============================================================
export default function OnlinePlay({ user, token, onExit }) {
  const { colors: C } = useSettings();
  const [name, setName] = useState(user?.username || "");
  const [nameConfirmed, setNameConfirmed] = useState(!!user?.username);
  const [joinCode, setJoinCode] = useState("");

  const mp = useMultiplayer(name, token);

  const inputStyle = { width: "100%", padding: "11px 14px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", color: C.tx, fontSize: "var(--fs-body)", fontFamily: "var(--font-ui)", outline: "none", boxSizing: "border-box", textAlign: "center" };

  const exitAll = () => { mp.leaveRoom(); onExit(); };

  if (!nameConfirmed) {
    return (
      <div className="cm-screen" style={{ minHeight: "100vh", background: C.bgGradient || C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "18px", fontFamily: "var(--font-ui)" }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-display)", fontWeight: 800, color: C.tx }}>Play Online</div>
        <input style={{ ...inputStyle, width: "240px" }} placeholder="Your name" value={name} maxLength={20} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim() && setNameConfirmed(true)} autoFocus />
        <Button variant="primary" disabled={!name.trim()} onClick={() => setNameConfirmed(true)}>Continue</Button>
        <Button variant="ghost" size="sm" onClick={onExit}>← Back</Button>
      </div>
    );
  }

  if (mp.phase === "idle") {
    return (
      <div className="cm-screen" style={{ minHeight: "100vh", background: C.bgGradient || C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "22px", fontFamily: "var(--font-ui)" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-display)", fontWeight: 800, color: C.tx }}>Play Online</div>
          <div style={{ fontSize: "var(--fs-small)", color: C.txMut, marginTop: "4px" }}>Playing as <strong style={{ color: C.tx }}>{name}</strong>{!user && <span> (guest — sign in to track ELO)</span>}</div>
        </div>

        {mp.errorMsg && <div style={{ color: C.danger, fontSize: "var(--fs-small)" }}>{mp.errorMsg}</div>}

        <div className="cm-card" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "var(--r-xl)", padding: "28px", display: "flex", flexDirection: "column", alignItems: "center", gap: "18px", width: "100%", maxWidth: "360px", boxShadow: "var(--sh-lg)" }}>
          <Button variant="primary" style={{ width: "100%" }} onClick={() => mp.createRoom(name)}>Create Room</Button>

          <div style={{ display: "flex", alignItems: "center", gap: "10px", width: "100%" }}>
            <div style={{ height: "1px", flex: 1, background: C.border }} />
            <span style={{ color: C.txMut, fontSize: "var(--fs-caption)" }}>OR</span>
            <div style={{ height: "1px", flex: 1, background: C.border }} />
          </div>

          <div style={{ display: "flex", gap: "8px", width: "100%" }}>
            <input style={{ ...inputStyle, textTransform: "uppercase" }} placeholder="ROOM CODE" value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} />
            <Button variant="secondary" disabled={!joinCode.trim()} onClick={() => mp.joinRoom(joinCode.trim(), name)}>Join</Button>
          </div>
        </div>

        <Button variant="ghost" size="sm" onClick={exitAll}>← Back to Menu</Button>
      </div>
    );
  }

  if (mp.phase === "waiting") {
    return (
      <div className="cm-screen" style={{ minHeight: "100vh", background: C.bgGradient || C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "18px", fontFamily: "var(--font-ui)" }}>
        <div className="cm-breathe" style={{ fontSize: "var(--fs-h2)", color: C.tx, fontFamily: "var(--font-display)" }}>Waiting for opponent...</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: "2.2rem", fontWeight: 700, color: C.gold, letterSpacing: "0.2em", background: C.surface, border: `1px solid ${C.border}`, padding: "14px 32px", borderRadius: "var(--r-lg)", boxShadow: "var(--sh-md)" }}>{mp.roomId}</div>
        <Button variant="secondary" size="sm" onClick={() => navigator.clipboard?.writeText(mp.roomId)}>📋 Copy Room Code</Button>
        <div style={{ fontSize: "var(--fs-caption)", color: C.txMut }}>Share this code with your opponent to join</div>
        <Button variant="ghost" size="sm" onClick={exitAll}>Cancel</Button>
      </div>
    );
  }

  const { game } = mp;
  const myTurn = game.turn === mp.myColor;
  const opponent = mp.players.find(p => p.color !== mp.myColor);

  const handleClick = (r, c) => {
    if (mp.phase !== "playing" || !myTurn) return;
    game.click(r, c);
  };

  const playerBadge = (playerName, isMe, color) => (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 12px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-full)" }}>
      <div style={{ width: "26px", height: "26px", borderRadius: "50%", background: `linear-gradient(160deg, ${C.wood}, ${C.woodDk})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.8rem" }}>{color === "w" ? "⬜" : "⬛"}</div>
      <div>
        <div style={{ fontSize: "0.68rem", color: C.txMut, letterSpacing: "0.06em" }}>{isMe ? "YOU" : ""}</div>
        <div style={{ fontSize: "var(--fs-small)", fontWeight: 600, color: C.tx }}>{playerName}</div>
      </div>
    </div>
  );

  return (
    <div className="cm-screen" style={{ minHeight: "100vh", background: C.bgGradient || C.bg, display: "flex", flexDirection: "column", alignItems: "center", fontFamily: "var(--font-ui)", padding: "16px", gap: "14px" }}>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", maxWidth: "1000px", flexWrap: "wrap", gap: "10px" }}>
        <Button variant="ghost" size="sm" onClick={exitAll}>← Leave</Button>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {playerBadge(opponent?.name || "...", false, opponent?.color)}
          {playerBadge(name, true, mp.myColor)}
        </div>
        {mp.roomId && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "var(--r-md)", padding: "6px 10px" }}>
            <div>
              <div style={{ fontSize: "0.6rem", color: C.txMut, letterSpacing: "0.1em" }}>ROOM CODE</div>
              <div style={{ fontSize: "var(--fs-small)", fontWeight: 700, color: C.gold, letterSpacing: "0.1em" }}>{mp.roomId}</div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => navigator.clipboard?.writeText(mp.roomId)}>Copy</Button>
          </div>
        )}
      </div>

      {mp.opponentDisconnected && mp.phase === "playing" && (
        <div className="cm-banner" style={{ background: C.danger, color: "#fff", padding: "8px 18px", borderRadius: "var(--r-md)", fontSize: "var(--fs-small)" }}>⚠ Opponent disconnected</div>
      )}

      <div style={{ display: "flex", gap: "18px", alignItems: "flex-start", justifyContent: "center", flexWrap: "wrap", width: "100%", maxWidth: "1000px" }}>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: "160px" }}>
          <CapturedPieces label="White" pieces={game.capt.w} />
          <CapturedPieces label="Black" pieces={game.capt.b} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
          <ChessBoard board={game.board} sel={game.sel} mvSet={game.mvSet} lastMv={game.lastMv} ckKing={game.ckKing} onSquareClick={handleClick} />

          <div style={{ fontSize: "var(--fs-small)", color: myTurn ? C.gold : C.txMut, fontWeight: 700, letterSpacing: "0.06em" }}>
            {mp.phase === "ended" ? "GAME OVER" : myTurn ? "YOUR TURN" : `WAITING FOR ${(opponent?.name || "OPPONENT").toUpperCase()}...`}
          </div>

          {mp.phase === "ended" && mp.endInfo && (
            <div className="cm-modal-pop" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "var(--r-lg)", padding: "16px 24px" }}>
              <div style={{ color: C.tx, fontSize: "var(--fs-body)", fontWeight: 700, fontFamily: "var(--font-display)" }}>
                {mp.endInfo.result === "resign" ? `${mp.endInfo.winner} wins by resignation` :
                 mp.endInfo.result === "checkmate" ? `${mp.endInfo.winner} wins by checkmate` :
                 mp.endInfo.result === "disconnect" ? "Opponent disconnected" : "Draw"}
              </div>
              {mp.endInfo.eloChange && (
                <div style={{ display: "flex", gap: "16px", fontSize: "var(--fs-caption)", color: C.txMut }}>
                  {["white", "black"].map(side => {
                    const e = mp.endInfo.eloChange[side]; if (!e) return null;
                    const diff = e.new - e.old;
                    return <span key={side}>{e.username}: {e.old} → {e.new} <span style={{ color: diff >= 0 ? C.success : C.danger }}>({diff >= 0 ? "+" : ""}{diff})</span></span>;
                  })}
                </div>
              )}
              {!mp.rematchOffered && !mp.rematchRequested && <Button variant="primary" onClick={mp.requestRematch}>Request Rematch</Button>}
              {mp.rematchRequested && !mp.rematchOffered && <div style={{ color: C.txMut, fontSize: "var(--fs-caption)" }}>Rematch request sent...</div>}
              {mp.rematchOffered && <Button variant="primary" onClick={mp.acceptRematch}>Accept Rematch</Button>}
            </div>
          )}

          {mp.phase === "playing" && <Button variant="danger" size="sm" onClick={mp.resign}>Resign</Button>}
        </div>

        <ChatPanel messages={mp.chat} onSend={mp.sendMessage} disabled={mp.phase === "idle"} />
      </div>

      <PromotionModal promo={game.promo} onPick={game.doPromo} />
    </div>
  );
}
