import { useSettings } from "../../contexts/SettingsContext";

// ============================================================
// components/ui/Chip.js — pill قابلة للاختيار (time control, theme picker, tabs)
// ============================================================
export default function Chip({ active, children, icon, style, ...rest }) {
  const { colors: C } = useSettings();

  return (
    <div
      className="cm-chip"
      role="button" tabIndex={0}
      style={{
        padding: "8px 16px",
        borderRadius: "var(--r-full)",
        cursor: "pointer",
        fontSize: "var(--fs-small)",
        fontWeight: 600,
        fontFamily: "var(--font-ui)",
        border: `1px solid ${active ? "transparent" : C.border}`,
        background: active ? `linear-gradient(180deg, ${C.accentHv}, ${C.accent})` : "transparent",
        color: active ? "#fff8ec" : C.txMut,
        boxShadow: active ? "var(--sh-sm)" : "none",
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        userSelect: "none",
        ...style,
      }}
      {...rest}
    >
      {icon}{children}
    </div>
  );
}
