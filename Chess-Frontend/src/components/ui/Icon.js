// src/components/ui/Icon.js
import React from "react";
import backMain from "../../svg/back-icon-main.svg";
import backWhite from "../../svg/back-icon-white.svg";
import chatMain from "../../svg/chat-icon-main.svg";
import chatWhite from "../../svg/chat-icon-white.svg";
import chessCupMain from "../../svg/chess-cup-main.svg";
import chessCupWhite from "../../svg/chess-cup-white.svg";
import chessStrategyMain from "../../svg/chess-strategy-main.svg";
import chessStrategyWhite from "../../svg/chess-strategy-white.svg";
import chessLogoMain from "../../svg/chess-logo-main.svg";
import chessLogoWhite from "../../svg/chess-logo-white.svg";
import onlineChessMain from "../../svg/online-chess-main.svg";
import onlineChessWhite from "../../svg/online-chess-white.svg";
import knockOutStageMain from "../../svg/knock-out-stage-main.svg";
import knockOutStageWhite from "../../svg/knock-out-stage-icon-white.svg";
import chessMain from "../../svg/chess-icon-main.svg";
import chessWhite from "../../svg/chess-icon-white.svg";

// Simple inline SVG icons – professional minimal designs
const icons = {
  profile: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z" />
    </svg>
  ),
  friends: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16 12c2.2 0 4-1.8 4-4s-1.8-4-4-4-4 1.8-4 4 1.8 4 4 4zm-8 0c2.2 0 4-1.8 4-4S10.2 4 8 4 4 5.8 4 8s1.8 4 4 4zm0 2c-2.7 0-8 1.4-8 4v2h16v-2c0-2.6-5.3-4-8-4zm8 0c-.3 0-.6 0-.9.1 1.2.9 2.1 2.1 2.1 3.9v2h8v-2c0-2.6-5.3-4-8-4z" />
    </svg>
  ),
  logout: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16 13v-2H7V8l-5 4 5 4v-3zM20 3h-8v2h8v14h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
    </svg>
  ),
  login: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10 17l5-5-5-5v3H3v4h7v3zM19 3h-2v18h2V3z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.63l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.06 7.06 0 0 0-1.63-.95l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.22-1.14.53-1.63.95l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.79a.5.5 0 0 0 .12.63l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.86a.5.5 0 0 0-.12.63l1.92 3.32c.14.24.44.34.68.22l2.39-.96c.49.42 1.04.73 1.63.95l.36 2.54c.05.27.28.42.5.42h3.84c.22 0 .45-.15.5-.42l.36-2.54c.59-.22 1.14-.53 1.63-.95l2.39.96c.24.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.63l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
    </svg>
  ),
  trophy: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17 5h-2V3a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v2H7a1 1 0 0 0-1 1v3c0 4.2 3.3 7.7 7.5 8V21h-3a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2h-3v-3.2c4.2-.3 7.5-3.8 7.5-8V6a1 1 0 0 0-1-1zM9 6h6v2H9V6zm4 11c-2.8-.4-5-2.9-5-5.9V8h10v3.1c0 2.9-2.2 5.5-5 5.9z" />
    </svg>
  ),
  medal: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l3.09 6.26L22 9l-5 4.87L18.18 22 12 18.27 5.82 22 7 13.87 2 9l6.91-.74L12 2z" />
    </svg>
  ),
  pawn: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2c-4.41 0-8 3.59-8 8 0 2.88 1.59 5.37 4 6.71V21h8v-4.29c2.41-1.34 4-3.83 4-6.71 0-4.41-3.59-8-8-8z" />
    </svg>
  ),
  crown: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M5 16l3-3 4 4 4-4 3 3v4H5zM2 20h20v2H2z" />
    </svg>
  ),
  lightning: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  ),
  dice: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="9" cy="9" r="1.5" />
      <circle cx="15" cy="9" r="1.5" />
      <circle cx="9" cy="15" r="1.5" />
      <circle cx="15" cy="15" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
    </svg>
  ),
  diamond: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l7 10-7 10-7-10 7-10z" />
    </svg>
  ),
  fire: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2c-2 3-3 5-3 9 0 4 2 6 3 7 1-1 3-3 3-7 0-4-1-6-3-9z" />
    </svg>
  ),
  // New themed icons
  back: { light: <img src={backMain} alt="Back" />, dark: <img src={backWhite} alt="Back" /> },
  chat: { light: <img src={chatMain} alt="Chat" />, dark: <img src={chatWhite} alt="Chat" /> },
  "chess-cup": { light: <img src={chessCupMain} alt="Leaderboard" />, dark: <img src={chessCupWhite} alt="Leaderboard" /> },
  "chess-strategy": { light: <img src={chessStrategyMain} alt="Settings" />, dark: <img src={chessStrategyWhite} alt="Settings" /> },
  "chess-logo": { light: <img src={chessLogoMain} alt="Logo" />, dark: <img src={chessLogoWhite} alt="Logo" /> },
  "online-chess": { light: <img src={onlineChessMain} alt="Online" />, dark: <img src={onlineChessWhite} alt="Online" /> },
  "knock-out-stage": { light: <img src={knockOutStageMain} alt="Tournaments" />, dark: <img src={knockOutStageWhite} alt="Tournaments" /> },
  chess: { light: <img src={chessMain} alt="Chess" />, dark: <img src={chessWhite} alt="Chess" /> },

};

export default function Icon({ name, size = 24, title, className }) {
  // Detect dark mode via prefers-color-scheme or data-theme attribute
  const isDark = typeof window !== "undefined" && (
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ||
    document.documentElement.getAttribute('data-theme') === 'dark'
  );

  const entry = icons[name];
  if (!entry) return null;
  const icon = typeof entry === 'object' && entry.light && entry.dark ? (isDark ? entry.dark : entry.light) : entry;
  // If the icon is an <img>, clone with size props; otherwise clone the SVG element.
  if (React.isValidElement(icon) && icon.type === 'img') {
    return React.cloneElement(icon, { width: size, height: size, alt: title || name, className });
  }
  return React.cloneElement(icon, { width: size, height: size, title, className });
}
