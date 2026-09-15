// src/components/FriendsModal.js
import { useState, useEffect } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { getFriends, getFriendRequests, sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend, getMyAchievements } from "../api/client";
import { ACHIEVEMENT_INFO } from "../constants/achievements";
import Icon from "./ui/Icon";
import Button from "./ui/Button";

// ============================================================
// components/FriendsModal.js — Friend System + Achievements
// ============================================================
export default function FriendsModal({ token, onClose }) {
  const { colors: C } = useSettings();
  const [tab, setTab] = useState("friends");
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [achievements, setAchievements] = useState([]);
  const [username, setUsername] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([getFriends(token), getFriendRequests(token), token ? getMyAchievements(token) : Promise.resolve({ achievements: [] })])
      .then(([f, r, a]) => { setFriends(f.friends || []); setRequests(r.requests || []); setAchievements(a.achievements || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(load, [token]);

  const addFriend = async () => {
    if (!username.trim()) return;
    setMsg("");
    try { await sendFriendRequest(token, username.trim()); setMsg("Request sent!"); setUsername(""); }
    catch (e) { setMsg(e.message); }
  };

  const accept = async (id) => { await acceptFriendRequest(token, id); load(); };
  const decline = async (id) => { await declineFriendRequest(token, id); load(); };
  const remove = async (id) => { if (window.confirm("Remove this friend?")) { await removeFriend(token, id); load(); } };

  const tabStyle = (active) => ({ padding: "8px 16px", borderRadius: "var(--r-full)", cursor: "pointer", fontSize: "var(--fs-small)", fontWeight: 600, border: `1px solid ${active ? "transparent" : C.border}`, background: active ? `linear-gradient(180deg, ${C.accentHv}, ${C.accent})` : "transparent", color: active ? "#fff8ec" : C.txMut });
  const inputStyle = { flex: 1, padding: "10px 14px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", color: C.tx, fontSize: "var(--fs-small)", fontFamily: "var(--font-ui)", outline: "none" };
  const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)" };

  // Prepare achievements list: use fetched achievements if available, otherwise fallback to static info
  const allAchievements = achievements.length ? achievements : Object.entries(ACHIEVEMENT_INFO).map(([key, v]) => ({
    key,
    name: v.name,
    icon: v.icon,
    description: "",
    earned_at: null,
  }));

  return (
    <div className="cm-fade-in" onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(6,4,2,0.8)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: "14px" }}>
      <div className="cm-modal-pop" style={{
        background: `linear-gradient(155deg, ${C.surfaceHover}, ${C.modalBg})`, border: `1px solid ${C.border}`, borderRadius: "var(--r-xl)",
        boxShadow: "var(--sh-lg)", width: "100%", maxWidth: "760px", maxHeight: "86vh", overflow: "hidden",
        display: "flex", flexWrap: "wrap",
      }}>
        {/* LEFT: Friends */}
        <div style={{ flex: "1 1 360px", padding: "24px", borderRight: `1px solid ${C.border}`, overflowY: "auto", maxHeight: "86vh" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <div style={tabStyle(tab === "friends")} onClick={() => setTab("friends")}>♜ Friends</div>
              <div style={tabStyle(tab === "requests")} onClick={() => setTab("requests")}>
                Pending {requests.length > 0 && `(${requests.length})`}
              </div>
            </div>
            <button onClick={onClose} style={{ background: "transparent", border: "none", color: C.txMut, fontSize: "1.2rem", cursor: "pointer" }}><Icon name="back" size={24} /></button>
          </div>

          <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
            <input style={inputStyle} placeholder="Add Friend by Username..." value={username} onChange={e => setUsername(e.target.value)} onKeyDown={e => e.key === "Enter" && addFriend()} />
            <Button variant="primary" size="sm" onClick={addFriend}>Add</Button>
          </div>
          {msg && <div style={{ fontSize: "var(--fs-caption)", color: msg === "Request sent!" ? C.success : C.danger, marginBottom: "10px" }}>{msg}</div>}

          {loading ? (
            <div style={{ textAlign: "center", color: C.txMut, padding: "20px" }}>Loading...</div>
          ) : tab === "friends" ? (
            friends.length === 0 ? (
              <div style={{ color: C.txMut, fontSize: "var(--fs-small)", textAlign: "center", padding: "16px" }}>No friends yet — add someone by username above.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {friends.map(f => (
                  <div key={f.friendship_id} style={rowStyle}>
                    <div>
                      <div style={{ color: C.tx, fontSize: "var(--fs-small)", fontWeight: 600 }}>{f.username}</div>
                      <div style={{ color: C.gold, fontSize: "var(--fs-caption)" }}>ELO {f.elo_rating}</div>
                    </div>
                    <span onClick={() => remove(f.friendship_id)} style={{ color: C.danger, cursor: "pointer", fontSize: "var(--fs-caption)" }}>Remove</span>
                  </div>
                ))}
              </div>
            )
          ) : (
            requests.length === 0 ? (
              <div style={{ color: C.txMut, fontSize: "var(--fs-small)", textAlign: "center", padding: "16px" }}>No pending requests.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {requests.map(r => (
                  <div key={r.friendship_id} style={rowStyle}>
                    <span style={{ color: C.tx, fontSize: "var(--fs-small)", fontWeight: 600 }}>{r.username}</span>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <span onClick={() => accept(r.friendship_id)} style={{ color: C.success, cursor: "pointer", fontSize: "var(--fs-caption)", fontWeight: 700 }}>Accept</span>
                      <span onClick={() => decline(r.friendship_id)} style={{ color: C.danger, cursor: "pointer", fontSize: "var(--fs-caption)", fontWeight: 700 }}>Decline</span>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          <div style={{ fontSize: "var(--fs-caption)", color: C.txFaint, textAlign: "center", marginTop: "16px" }}>
            To play together, create a room in "Play Online" and share the code.
          </div>
        </div>

        {/* RIGHT: Achievements */}
        <div style={{ flex: "1 1 280px", padding: "24px", overflowY: "auto", maxHeight: "86vh" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-h1)", fontWeight: 700, color: C.gold, marginBottom: "16px" }}>Achievements</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
            {allAchievements.map(a => (
              <div key={a.key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", textAlign: "center", opacity: a.earned_at ? 1 : 0.35 }}>
                <div style={{
                  width: "58px", height: "58px", borderRadius: "50%",
                  background: `radial-gradient(circle at 32% 28%, ${C.gold}, ${C.wood} 60%, ${C.woodBd} 100%)`,
                  border: `1px solid ${C.gold}`, boxShadow: a.earned_at ? `var(--sh-sm), 0 0 12px ${C.goldSoft}` : "var(--sh-sm)",
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem",
                }}>{a.icon}</div>
                <div style={{ fontSize: "var(--fs-caption)", fontWeight: 700, color: C.tx }}>{a.name}</div>
                {a.description && <div style={{ fontSize: "0.62rem", color: C.txMut, fontStyle: "italic" }}>{a.description}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
