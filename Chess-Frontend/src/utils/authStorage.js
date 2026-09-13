// ============================================================
// utils/authStorage.js — قراءة/كتابة بيانات المستخدم المحفوظة محليًا
// ============================================================
export const getStoredUser = () => {
  try { return JSON.parse(localStorage.getItem("chess_user")); }
  catch { return null; }
};

export const getStoredToken = () => localStorage.getItem("chess_token") || null;

export const storeAuth = (token, user) => {
  localStorage.setItem("chess_token", token);
  localStorage.setItem("chess_user", JSON.stringify(user));
};

export const clearAuth = () => {
  localStorage.removeItem("chess_token");
  localStorage.removeItem("chess_user");
};
