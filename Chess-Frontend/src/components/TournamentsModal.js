import { useState, useEffect, useCallback } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { listTournaments, getTournament, createTournament, joinTournament, startTournament, reportMatchResult } from "../api/client";
import Button from "./ui/Button";
import Chip from "./ui/Chip";

const SIZES = [4, 8, 16];

const STATUS_COLOR = { open: "#5a8fc4", in_progress: "#e0b24a", finished: "#4caf6d" };
const STATUS_LABEL = { open: "Open", in_progress: "In Progress", finished: "Finished" };

// ============================================================
// components/TournamentsModal.js — Tournament Mode (single elimination)
// ============================================================
export default function TournamentsModal({ token, user, onClose }) {
  const { colors: C } = useSettings();
  const [view, setView] = useState("list");
  const [tournaments, setTournaments] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [search, setSearch] = useState("");

  const loadList = () => {
    setLoading(true);
    listTournaments().then(d => { setTournaments(d.tournaments || []); setLoading(false); }).catch(() => setLoading(false));
  };
  const loadDetail = useCallback((id) => {
    setLoading(true);
    getTournament(id).then(d => { setDetail(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { if (view === "list") loadList(); }, [view]);

  const openDetail = (id) => { setView("detail"); loadDetail(id); };
  const create = async () => {
    setErr("");
    if (name.trim().length < 3) return setErr("Name must be at least 3 characters");
    try { const { tournament } = await createTournament(token, name.trim(), maxPlayers); setName(""); openDetail(tournament.id); }
    catch (e) { setErr(e.message); }
  };
  const join = async (id) => { setErr(""); try { await joinTournament(token, id); loadDetail(id); } catch (e) { setErr(e.message); } };
  const start = async (id) => { setErr(""); try { await startTournament(token, id); loadDetail(id); } catch (e) { setErr(e.message); } };
  const report = async (matchId, winnerId) => { setErr(""); try { await reportMatchResult(token, matchId, winnerId); loadDetail(detail.tournament.id); } catch (e) { setErr(e.message); } };

  const filtered = tournaments.filter(t => t.name.toLowerCase().includes(search.toLowerCase()));
  const inputStyle = { padding: "10px 14px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", color: C.tx, fontSize: "var(--fs-small)", fontFamily: "var(--font-ui)", outline: "none" };
  const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)" };

  return (
    <div className="cm-fade-in" onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(6,4,2,0.8)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: "14px" }}>
      <div className="cm-modal-pop" style={{ background: `linear-gradient(155deg, ${C.surfaceHover}, ${C.modalBg})`, border: `1px solid ${C.border}`, borderRadius: "var(--r-xl)", padding: "26px", width: "560px", maxWidth: "94vw", maxHeight: "86vh", overflowY: "auto", boxShadow: "var(--sh-lg)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-h1)", fontWeight: 700, color: C.gold }}>
            🏅 {view === "detail" ? detail?.tournament?.name || "..." : "Tournaments"}
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.txMut, fontSize: "1.2rem", cursor: "pointer" }}>✕</button>
        </div>

        {err && <div style={{ color: C.danger, fontSize: "var(--fs-small)", marginBottom: "10px" }}>{err}</div>}

        {view === "list" && (
          <>
            <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
              <input style={{ ...inputStyle, flex: 1, minWidth: "160px" }} placeholder="Search Tournaments..." value={search} onChange={e => setSearch(e.target.value)} />
              <Button variant="primary" disabled={!token} onClick={() => setView("create")} icon="+">Create Tournament</Button>
            </div>
            {!token && <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, marginBottom: "10px" }}>Sign in to create or join tournaments — you can still browse.</div>}

            {loading ? (
              <div style={{ textAlign: "center", color: C.txMut, padding: "20px" }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ color: C.txMut, fontSize: "var(--fs-small)", textAlign: "center", padding: "16px" }}>No tournaments yet — start one!</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {filtered.map(t => (
                  <div key={t.id} className="cm-card" style={rowStyle}>
                    <div>
                      <div style={{ color: C.tx, fontSize: "var(--fs-body)", fontWeight: 700, fontFamily: "var(--font-display)" }}>{t.name}</div>
                      <div style={{ color: C.txMut, fontSize: "var(--fs-caption)" }}>Single elimination · {t.player_count}/{t.max_players} players</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                      <span style={{ fontSize: "var(--fs-caption)", fontWeight: 700, color: STATUS_COLOR[t.status], border: `1px solid ${STATUS_COLOR[t.status]}`, borderRadius: "var(--r-full)", padding: "3px 12px" }}>{STATUS_LABEL[t.status]}</span>
                      <Button variant="secondary" size="sm" onClick={() => openDetail(t.id)}>{t.player_count >= t.max_players ? "View" : "View Bracket"}</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {view === "create" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Tournament name" maxLength={80} style={inputStyle} />
            <div style={{ display: "flex", gap: "8px" }}>
              {SIZES.map(s => <Chip key={s} active={maxPlayers === s} onClick={() => setMaxPlayers(s)}>{s} players</Chip>)}
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <Button variant="primary" onClick={create}>Create</Button>
              <Button variant="ghost" onClick={() => setView("list")}>Cancel</Button>
            </div>
          </div>
        )}

        {view === "detail" && (
          loading || !detail ? (
            <div style={{ textAlign: "center", color: C.txMut, padding: "20px" }}>Loading...</div>
          ) : (
            <TournamentDetail detail={detail} user={user} token={token} onJoin={() => join(detail.tournament.id)} onStart={() => start(detail.tournament.id)} onReport={report} onBack={() => setView("list")} C={C} />
          )
        )}
      </div>
    </div>
  );
}

function TournamentDetail({ detail, user, token, onJoin, onStart, onReport, onBack, C }) {
  const { tournament: t, players, matches } = detail;
  const isCreator = user && t.creator_id === user.id;
  const isPlayer = user && players.some(p => p.id === user.id);
  const rounds = [...new Set(matches.map(m => m.round))].sort((a, b) => a - b);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <Button variant="ghost" size="sm" style={{ alignSelf: "flex-start" }} onClick={onBack}>← All Tournaments</Button>

      <div style={{ fontSize: "var(--fs-small)", color: C.txMut }}>
        {players.length}/{t.max_players} players · <span style={{ color: STATUS_COLOR[t.status], fontWeight: 700 }}>{STATUS_LABEL[t.status]}</span>
        {t.status === "finished" && t.winner_id && <span style={{ color: C.gold }}> · 🏆 Champion: {players.find(p => p.id === t.winner_id)?.username}</span>}
      </div>

      {t.status === "open" && (
        <div style={{ display: "flex", gap: "10px" }}>
          {!isPlayer && <Button variant="primary" size="sm" disabled={!token} onClick={onJoin}>Join Tournament</Button>}
          {isCreator && players.length >= 2 && <Button variant="secondary" size="sm" onClick={onStart}>Start ({players.length} players)</Button>}
        </div>
      )}

      {t.status === "open" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ fontSize: "var(--fs-caption)", color: C.txMut, letterSpacing: "0.1em", textTransform: "uppercase" }}>Players</div>
          {players.map(p => <div key={p.id} style={{ fontSize: "var(--fs-small)", color: C.tx }}>{p.username} <span style={{ color: C.txMut, fontSize: "var(--fs-caption)" }}>· ELO {p.elo_rating}</span></div>)}
        </div>
      )}

      {t.status !== "open" && (
        <div style={{ display: "flex", gap: "16px", overflowX: "auto", paddingBottom: "6px" }}>
          {rounds.map(r => (
            <div key={r} style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: "170px" }}>
              <div style={{ fontSize: "var(--fs-caption)", color: C.gold, letterSpacing: "0.1em", textAlign: "center", fontWeight: 700 }}>
                {matches.filter(m => m.round === r).length === 1 ? "FINAL" : `ROUND ${r}`}
              </div>
              {matches.filter(m => m.round === r).map(m => {
                const canReport = user && m.status === "pending" && [m.player1_id, m.player2_id].includes(user.id);
                return (
                  <div key={m.id} style={{ background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", padding: "8px 10px", fontSize: "var(--fs-small)" }}>
                    <div style={{ color: m.winner_id === m.player1_id ? C.success : C.tx, display: "flex", justifyContent: "space-between", fontWeight: m.winner_id === m.player1_id ? 700 : 400 }}>
                      <span>{m.player1_name || "TBD"}</span>
                      {canReport && m.player1_id && <span onClick={() => onReport(m.id, m.player1_id)} style={{ cursor: "pointer", color: C.gold, textDecoration: "underline", fontSize: "var(--fs-caption)" }}>won</span>}
                    </div>
                    <div style={{ color: C.txFaint, fontSize: "0.6rem", textAlign: "center" }}>vs</div>
                    <div style={{ color: m.winner_id === m.player2_id ? C.success : C.tx, display: "flex", justifyContent: "space-between", fontWeight: m.winner_id === m.player2_id ? 700 : 400 }}>
                      <span>{m.status === "bye" ? "BYE" : (m.player2_name || "TBD")}</span>
                      {canReport && m.player2_id && <span onClick={() => onReport(m.id, m.player2_id)} style={{ cursor: "pointer", color: C.gold, textDecoration: "underline", fontSize: "var(--fs-caption)" }}>won</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: "var(--fs-caption)", color: C.txFaint, textAlign: "center" }}>
        Play your match via "Play Online" (share a room code), then report the winner here.
      </div>
    </div>
  );
}
