import { useEffect, useState } from "react";
import { verifyEmail, resetPassword } from "../api/client";
import { useSettings } from "../contexts/SettingsContext";
import Button from "./ui/Button";

export default function AccountAction() {
  const { colors: C } = useSettings();
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";
  const verification = window.location.pathname === "/verify-email";
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(verification ? "Verifying your email…" : "Choose a new password");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!verification) return;
    verifyEmail(token).then(data => setMessage(data.message)).catch(err => { setError(err.message); setMessage(""); });
  }, [token, verification]);

  const reset = async () => {
    setError("");
    try {
      const data = await resetPassword(token, password);
      setMessage(data.message);
      setPassword("");
    } catch (err) { setError(err.message); }
  };

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: C.bg, color: C.tx }}>
      <section style={{ width: "min(400px, 90vw)", padding: 32, border: `1px solid ${C.border}`, borderRadius: 16, background: C.modalBg }}>
        <h1 style={{ color: C.gold }}>{verification ? "Verify email" : "Reset password"}</h1>
        {!verification && !message.includes("complete") && (
          <input type="password" minLength="10" maxLength="128" value={password} onChange={event => setPassword(event.target.value)}
            placeholder="At least 10 characters" style={{ width: "100%", boxSizing: "border-box", padding: 12, marginBottom: 16 }} />
        )}
        {!verification && !message.includes("complete") && <Button variant="primary" disabled={password.length < 10} onClick={reset}>Reset password</Button>}
        {message && <p>{message}</p>}
        {error && <p style={{ color: C.danger }}>{error}</p>}
        <p><a href="/" style={{ color: C.gold }}>Return to Chess</a></p>
      </section>
    </main>
  );
}
