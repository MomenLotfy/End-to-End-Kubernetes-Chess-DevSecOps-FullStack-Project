import { useState } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { login, register, forgotPassword } from "../api/client";
import { storeAuth } from "../utils/authStorage";
import Button from "./ui/Button";

// ============================================================
// components/AuthModal.js — نافذة تسجيل الدخول / إنشاء حساب
// ============================================================
export default function AuthModal({ onClose, onSuccess }) {
  const { colors: C } = useSettings();
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ username: "", email: "", password: "" });
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr(""); setLoading(true);
    try {
      if (mode === "forgot") {
        const data = await forgotPassword(form.email);
        setErr(data.message);
        return;
      }
      const data = mode === "login" ? await login(form.email, form.password) : await register(form.username, form.email, form.password);
      if (mode === "register") {
        setErr(data.message);
        setMode("login");
        return;
      }
      storeAuth(data.user);
      onSuccess(data.user);
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const field = (ph, k, type = "text") => (
    <input key={k} type={type} placeholder={ph} value={form[k]}
      onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))}
      style={{ width: "100%", padding: "11px 14px", background: C.pnl, border: `1px solid ${C.pnlBd}`, borderRadius: "var(--r-md)", color: C.tx, fontSize: "var(--fs-body)", fontFamily: "var(--font-ui)", outline: "none", boxSizing: "border-box" }}
    />
  );

  return (
    <div className="cm-fade-in" onClick={e => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(6,4,2,0.8)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
      <div className="cm-modal-pop" style={{ background: `linear-gradient(155deg, ${C.surfaceHover}, ${C.modalBg})`, border: `1px solid ${C.border}`, borderRadius: "var(--r-xl)", padding: "32px 34px", width: "320px", display: "flex", flexDirection: "column", gap: "14px", boxShadow: "var(--sh-lg)" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "var(--fs-h1)", fontWeight: 700, color: C.gold }}>{mode === "login" ? "♞ Sign In" : mode === "register" ? "♞ Register" : "Reset password"}</div>
        </div>
        {mode === "register" && field("Username", "username")}
        {field("Email", "email", "email")}
        {mode !== "forgot" && field("Password", "password", "password")}
        {mode === "login" && <button type="button" onClick={() => { setMode("forgot"); setErr(""); }} style={{ border: 0, background: "none", color: C.gold, cursor: "pointer" }}>Forgot password?</button>}
        {err && <div style={{ color: C.danger, fontSize: "var(--fs-caption)", textAlign: "center" }}>{err}</div>}
        <Button variant="primary" disabled={loading} onClick={submit} style={{ width: "100%" }}>{loading ? "..." : mode === "login" ? "Sign In" : mode === "register" ? "Register" : "Send reset link"}</Button>
        <div style={{ textAlign: "center", fontSize: "var(--fs-caption)", color: C.txMut }}>
          {mode === "login" ? "No account? " : "Have account? "}
          <span onClick={() => { setMode(m => m === "login" ? "register" : "login"); setErr(""); }} style={{ color: C.gold, cursor: "pointer", textDecoration: "underline" }}>
            {mode === "login" ? "Register" : "Sign In"}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Continue as Guest</Button>
      </div>
    </div>
  );
}
