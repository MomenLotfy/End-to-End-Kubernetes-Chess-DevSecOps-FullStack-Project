// src/components/ProfileModal.js
import { useState, useEffect } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { getProfile, updateProfile, getMyStats, getMyHistory, getMyAchievements, uploadAvatar } from "../api/client";
import StatsChart from "./StatsChart";
import ReplayModal from "./ReplayModal";
import Button from "./ui/Button";
import Icon from "./ui/Icon";

// ============================================================
// components/ProfileModal.js — صفحة الملف الشخصي (Profile Page)
// ============================================================
export default function ProfileModal({ token, onClose }) {
  const { colors: C } = useSettings();
  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);
  const [achievements, setAchievements] = useState([]);
  const [editing, setEditing] = useState(false);
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const [replayGameId, setReplayGameId] = useState(null);

  useEffect(() => {
    Promise.all([getProfile(token), getMyStats(token), getMyHistory(token), getMyAchievements(token)])
      .then(([p, s, h, a]) => { setProfile(p); setStats(s); setHistory(h.history || []); setAchievements(a.achievements || []); setBio(p.bio || ""); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  const save = async () => {
    setSaving(true); setErr("");
    try { const { user } = await updateProfile(token, { bio }); setProfile(user); setEditing(false); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const onAvatarPick = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true); setErr("");
    try { const { user } = await uploadAvatar(token, file); setProfile(user); }
    catch (ex) { setErr(ex.message); }
    finally { setUploading(false); }
  };

  const inputStyle = { width: "100%", padding: "9px 12px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", color: C.tx, fontSize: "var(--fs-small)", fontFamily: "var(--font-ui)", outline: "none", boxSizing: "border-box" };
  const sectionLabel = { fontSize: "var(--fs-caption)", color: C.txMut, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "10px" };

  return (
    <div className="cm-fade-in" onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(6,4,2,0.8)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: "14px" }}>
      <div className="cm-modal-pop" style={{ background: `linear-gradient(155deg, ${C.surfaceHover}, ${C.modalBg})`, border: `1px solid ${C.border}`, borderRadius: "var(--r-xl)", padding: "26px", width: "400px", maxWidth: "94vw", maxHeight: "85vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "16px", boxShadow: "var(--sh-lg)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-h1)", fontWeight: 700, color: C.gold }}>Profile</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.txMut, fontSize: "1.2rem", cursor: "pointer" }}><Icon name="back" size={24} /></button>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", color: C.txMut, padding: "20px" }}>Loading...</div>
        ) : !profile ? (
          <div style={{ textAlign: "center", color: C.txMut, padding: "20px" }}>Couldn't load profile.</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              <label style={{ width: "64px", height: "64px", borderRadius: "50%", background: `radial-gradient(circle at 32% 28%, ${C.wood}, ${C.woodDk})`, border: `2px solid ${C.gold}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0, cursor: "pointer", position: "relative", boxShadow: "var(--sh-sm)" }} title="Click to change avatar">
                {profile.avatar_url
                  ? <img src={profile.avatar_url} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { e.target.style.display = "none"; }} />
                  : <span style={{ fontSize: "1.6rem" }}><Icon name="chess" size={24} /></span>}
                <input type="file" accept="image/*" onChange={onAvatarPick} style={{ display: "none" }} />
                {uploading && <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.6rem", color: "#fff" }}>...</div>}
              </label>
              <div>
                <div style={{ color: C.tx, fontWeight: 700, fontSize: "var(--fs-h2)", fontFamily: "var(--font-display)" }}>{profile.username}</div>
                <div style={{ color: C.gold, fontSize: "var(--fs-caption)", fontWeight: 700 }}>ELO {profile.elo_rating ?? 1200}</div>
              </div>
            </div>

            {editing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <textarea style={{ ...inputStyle, minHeight: "60px", resize: "vertical" }} value={bio} maxLength={160} onChange={e => setBio(e.target.value)} placeholder="Bio (max 160 chars)" />
                {err && <div style={{ color: C.danger, fontSize: "var(--fs-caption)" }}>{err}</div>}
                <div style={{ display: "flex", gap: "8px" }}>
                  <Button variant="primary" size="sm" disabled={saving} onClick={save}>{saving ? "..." : "Save"}</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <>
                {err && <div style={{ color: C.danger, fontSize: "var(--fs-caption)" }}>{err}</div>}
                {profile.bio && <div style={{ color: C.tx, fontSize: "var(--fs-small)", fontStyle: "italic" }}>"{profile.bio}"</div>}
                <Button variant="ghost" size="sm" style={{ alignSelf: "flex-start" }} onClick={() => setEditing(true)}>Edit Bio</Button>
              </>
            )}

            <div style={{ height: "1px", background: C.border }} />
            <div>
              <div style={sectionLabel}>Stats</div>
              {stats && <StatsChart wins={stats.wins || 0} losses={stats.losses || 0} />}
              {stats?.best_moves && <div style={{ color: C.txMut, fontSize: "var(--fs-caption)", marginTop: "8px" }}>Best win: {stats.best_moves} moves in {stats.best_time}s</div>}
            </div>

            <div style={{ height: "1px", background: C.border }} />
            <div>
              <div style={sectionLabel}>Achievements ({achievements.filter(a => a.earned_at).length}/{achievements.length})</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "8px" }}>
                {achievements.map(a => (
                  <div key={a.key} title={`${a.name} — ${a.description}`} style={{ aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.3rem", borderRadius: "50%", background: a.earned_at ? `radial-gradient(circle at 32% 28%, ${C.gold}, ${C.wood})` : "rgba(0,0,0,0.25)", border: `1px solid ${a.earned_at ? C.gold : C.pnlBd}`, opacity: a.earned_at ? 1 : 0.3 }}>{a.icon}</div>
                ))}
              </div>
            </div>

            <div style={{ height: "1px", background: C.border }} />
            <div>
              <div style={sectionLabel}>Recent Games</div>
              {history.length === 0 ? (
                <div style={{ color: C.txMut, fontSize: "var(--fs-small)" }}>No games played yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {history.map(h => (
                    <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", fontSize: "var(--fs-caption)" }}>
                      <span style={{ color: h.winner ? C.success : C.txMut, fontWeight: 600 }}>{h.winner ? "Won" : "Lost/Draw"} · {h.moves} moves · {h.duration_seconds}s</span>
                      {h.game_id
                        ? <span onClick={() => setReplayGameId(h.game_id)} style={{ color: C.gold, cursor: "pointer", textDecoration: "underline" }}>▶ Replay</span>
                        : <span style={{ color: C.txFaint }}>no replay</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {replayGameId && <ReplayModal gameId={replayGameId} onClose={() => setReplayGameId(null)} />}
    </div>
  );
}
