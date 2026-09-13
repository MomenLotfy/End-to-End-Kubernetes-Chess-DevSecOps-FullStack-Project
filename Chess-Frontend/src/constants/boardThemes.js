// ============================================================
// constants/boardThemes.js — ألوان مربعات الرقعة (Board Themes)
// ============================================================
export const BOARD_THEMES = {
  classic: {
    key: "classic", name: "Classic Wood",
    lt: "#e9cfa8", dk: "#a9713f",
    selLt: "#f2d872", selDk: "#d1a94a",
    lastLt: "#e0c987", lastDk: "#b3924f",
    chk: "#d1554f",
  },
  emerald: {
    key: "emerald", name: "Emerald",
    lt: "#e9e6ca", dk: "#5c7a52",
    selLt: "#f2e08a", selDk: "#c9b256",
    lastLt: "#d9dba0", lastDk: "#8a9a5e",
    chk: "#c65a52",
  },
  sapphire: {
    key: "sapphire", name: "Sapphire",
    lt: "#dfe6ee", dk: "#3f6083",
    selLt: "#f0d878", selDk: "#c9ab52",
    lastLt: "#c6d6e6", lastDk: "#6c8daa",
    chk: "#d1554f",
  },
  slate: {
    key: "slate", name: "Slate",
    lt: "#e4e1da", dk: "#6f6b64",
    selLt: "#eed57e", selDk: "#c2a558",
    lastLt: "#d6d2c8", lastDk: "#95908a",
    chk: "#c85a52",
  },
};

export const BOARD_THEME_LIST = Object.values(BOARD_THEMES).map(t => ({ key: t.key, name: t.name }));
