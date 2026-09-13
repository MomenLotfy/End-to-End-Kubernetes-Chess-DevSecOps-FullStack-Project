import { useSettings } from "../../contexts/SettingsContext";

// ============================================================
// components/ui/Button.js — زرار موحّد لكل التطبيق
// variant: primary | secondary | ghost | danger
// size: md | sm
// ============================================================
export default function Button({ variant = "primary", size = "md", icon, children, style, disabled, ...rest }) {
  const { colors: C } = useSettings();

  const pad = size === "sm" ? "7px 16px" : "11px 26px";
  const fs = size === "sm" ? "var(--fs-caption)" : "var(--fs-small)";

  const base = {
    fontFamily: "var(--font-ui)",
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    borderRadius: "var(--r-md)",
    padding: pad,
    fontSize: fs,
    cursor: disabled ? "default" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    border: "1px solid transparent",
  };

  const variants = {
    primary: {
      background: `linear-gradient(180deg, ${C.accentHv}, ${C.accent})`,
      color: "#fff8ec",
      boxShadow: `var(--sh-sm), inset 0 1px 0 rgba(255,255,255,0.15)`,
      borderColor: "rgba(0,0,0,0.15)",
    },
    secondary: {
      background: "transparent",
      color: C.tx,
      borderColor: C.border,
    },
    ghost: {
      background: "transparent",
      color: C.txMut,
      borderColor: "transparent",
    },
    danger: {
      background: "transparent",
      color: C.danger,
      borderColor: C.danger,
    },
  };

  return (
    <button className="cm-btn" disabled={disabled} style={{ ...base, ...variants[variant], ...style }} {...rest}>
      {icon && <span style={{ fontSize: "1em", lineHeight: 1 }}>{icon}</span>}
      {children}
    </button>
  );
}
