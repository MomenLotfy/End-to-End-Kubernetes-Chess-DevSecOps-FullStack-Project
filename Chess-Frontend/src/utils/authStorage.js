// Only non-sensitive display state is persisted. Authentication credentials live exclusively
// in HttpOnly cookies and are therefore inaccessible to JavaScript.
export const getStoredUser = () => {
  localStorage.removeItem("chess_token");
  try { return JSON.parse(sessionStorage.getItem("chess_user")); }
  catch { return null; }
};

export const getStoredToken = () => Boolean(getStoredUser());

export const storeAuth = (user) => {
  localStorage.removeItem("chess_token");
  sessionStorage.setItem("chess_user", JSON.stringify(user));
};

export const clearAuth = () => {
  localStorage.removeItem("chess_token");
  localStorage.removeItem("chess_user");
  sessionStorage.removeItem("chess_user");
};
