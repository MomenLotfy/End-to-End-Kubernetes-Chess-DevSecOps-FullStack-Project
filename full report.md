# FULL SYSTEM AUDIT REPORT – Multiplayer Chess Full‑Stack Application
*(All observations are derived from the current source code; no files were changed.)*

---

## 1. Executive Summary

| Aspect | Overall Posture | Key Take‑aways |
|--------|----------------|----------------|
| **Architecture** | Functional but single‑instance‑only; in‑memory game rooms are the single source of truth while the database holds the authoritative state. | The design cannot be horizontally scaled and loses ongoing games on server restart; a few admin‑level actions lack explicit ownership verification. |
| **Authentication** | JWT‑based, with fallback secret `"chess‑secret‑key"` in both HTTP and Socket.io layers. Tokens are stored in **localStorage**. | Hard‑coded secret and insecure client storage are the highest‑severity security gaps. |
| **Authorization** | Most socket events enforce per‑player checks; REST endpoints guard actions with `authMiddleware`. | Some endpoints (e.g., tournament join) have non‑atomic capacity checks; a few admin‑level actions lack explicit ownership verification. |
| **Multiplayer Integrity** | Server‑authoritative move validation via `chess.js`; every move is persisted in a DB transaction before memory is updated. | Logic is sound, but abrupt server crashes can leave DB ↔ memory out of sync; remote‑play can be lost on restart. |
| **Database** | Normalised schema with foreign‑key constraints, indexes, and transactional helpers (`Game.runInTransaction`). | Missing unique constraints on some composite actions (e.g., tournament capacity) allow race‑condition over‑booking. |
| **Reliability** | Graceful handling of disconnects, but relies on in‑memory rooms; no persistence across restarts. | Potential loss of in‑progress games and inability to run multiple backend replicas. |
| **Security Configuration** | Helmet is used, but CSP is not set; CORS defaults to `"*"` if `FRONTEND_URL` is not defined. | Missing CSP and permissive CORS widen attack surface. |
| **Testing** | Unit tests exist for the backend (`coverage/…`) and a Jest config for the frontend, but no socket‑level or race‑condition tests. | Critical paths (socket events, tournament join races) are untested. |
| **Performance / Scalability** | Simple queries with proper indexes; however the in‑memory room map limits concurrency and scaling. | Scaling to > 1 instance will require external state store (e.g., Redis). |
| **Code Quality** | Consistent naming, modularised models, and thorough use of async/await. Some duplicated logic in socket‑event handlers and lack of linting for unused imports. | No show‑stoppers, but a few “dead code” warnings. |

The **most urgent** remediation areas are the **hard‑coded JWT secret**, **client‑side token storage**, and **in‑memory only game state**. Addressing those cuts the attack surface dramatically and enables horizontal scaling.

---

## 2. Architecture Findings

| Area | Observation | Impact | Suggested Mitigation |
|------|-------------|--------|----------------------|
| **Backend → Socket.io** | Active game rooms are kept exclusively in `activeRooms` (a `Map` in memory). No external store. | Single‑node bottleneck; loss of games on server restart/crash. | Persist room metadata in a shared store (Redis, PostgreSQL) or reconstruct from DB on startup. |
| **REST ↔ Socket.io** | Both APIs share the same JWT secret and verification logic. Socket events never read a token after the initial handshake. | Consistency good, but the fallback secret is risky. | Enforce presence of `JWT_SECRET` at startup; abort if missing. |
| **Database Transaction Helper** | `Game.runInTransaction` wraps write‑heavy operations and rolls back on error. | Strong consistency for game writes. | Keep, but add explicit retry logic for serialization failures. |
| **Stateless Services** | `api/client.js` builds URLs from `process.env.REACT_APP_API_URL` (defaults to localhost). | Hard‑coded defaults hinder deployment flexibility. | Use proper environment configuration and fail if undefined in production. |
| **Feature Coupling** | `socketAuthMiddleware` allows guest connections (`token` optional). Guest rooms are created with `userId = null`. | Allows unauthenticated play (intended) but may be abused for DoS or spam. | Rate‑limit guest socket connections & enforce CAPTCHA for room creation if needed. |
| **Single Point of Failure** | `logger` is the only external dependency; no fallback if logging service fails. | Logging failure could hide attacks. | Consider buffering logs and retrying, or using a robust log aggregator. |
| **Scalability** | No load‑balancer‑aware sticky‑session handling; socket connections are bound to the node that created the room. | Horizontal scaling impossible without shared state. | Adopt a pub/sub (e.g., Redis) for socket events and share room state. |
| **Rate Limiting** | Global limiter `100 requests / 15 min` for **all** `/api/*`. | May be too permissive for auth endpoints; too strict for public data. | Apply stricter per‑endpoint/IP limits on `/auth/*` and lighter limits on read‑only endpoints. |
| **Static Asset Serving** | `/uploads` is served as a static folder with a permissive CORS header (`*`). | Uploaded avatars can be fetched by any site, potentially exposing user‑identifiable data. | Restrict to the frontend origin or require signed URLs. |

---

## 3. Security Findings

| # | Category | File / Location | Problem | Why it matters | Exploit / Failure Scenario |
|---|----------|----------------|---------|----------------|----------------------------|
| **CHESS‑001** | Authentication | `Chess-Backend/src/middleware/auth.js` (line 17) & `Chess-Backend/src/socket/socketAuth.js` (line 15) | **Hard‑coded JWT secret fallback** (`"chess-secret-key"`). | If `JWT_SECRET` env var is missing or unchanged in production, an attacker can forge valid tokens and impersonate any user. | Attacker crafts JWT with admin `id` and `username`, gains full API and socket privileges. |
| **CHESS‑002** | Front‑end Security | `Chess-Frontend/src/utils/authStorage.js` (line 9) | **JWT stored in `localStorage`**. | XSS can read the token and reuse it on any origin (CSRF‑free API calls). | Malicious script injected via a reflected XSS or a third‑party library steals the token and performs API actions as the victim. |
| **CHESS‑003** | Configuration | `docker-compose.yml` (service `chess-backend` env `JWT_SECRET=chess-jwt-secret-CHANGE-ME-IN-PRODUCTION`) | Secret is hard‑coded in the repo and may be used unchanged. | Same as CHESS‑001; developers might forget to replace it. | Production deployment with default secret allows token forgery. |
| **CHESS‑004** | CORS / CSRF | `Chess-Backend/src/server.js` (lines 47‑50) | `origin: process.env.FRONTEND_URL || "*"` – defaults to wildcard. | Allows any site to make authenticated XHR requests if it can obtain the token (e.g., via XSS). | Attacker scripts credential‑stuffing against `/login` unlimitedly until they succeed. |
| **CHESS‑005** | Content Security Policy | `Chess-Backend/src/server.js` – Helmet is used but CSP not configured. | Missing CSP makes it easier to inject malicious scripts (e.g., via SVG avatar). | Upload a crafted SVG containing `<script>alert(1)</script>` → displayed in profile, XSS. |
| **CHESS‑006** | Rate Limiting | `Chess-Backend/src/server.js` (global limiter). | No per‑IP or per‑endpoint throttling for login/registration. | Brute‑force of passwords is feasible; no per‑endpoint limit on `/auth/login`. |
| **CHESS‑007** | File Upload Validation | `Chess-Backend/src/middleware/upload.js` (lines 19‑24) | Only checks file **extension** against an allow‑list; content is not inspected. | Malicious files (e.g., SVG with script) could be stored and later served. |
| **CHESS‑008** | Avatar Access Control | `Chess-Backend/src/server.js` static `/uploads` route (lines 63‑77) | Served without authentication; filename guessability allows enumeration. |
| **CHESS‑009** | In‑Memory State Loss | `Chess-Backend/src/socket/gameSocket.js` (activeRooms map). | On server crash/restart the map is cleared; ongoing games become orphaned. |
| **CHESS‑010** | Tournament Join Race Condition | `Chess-Backend/src/models/Tournament.js` → `join` (lines 74‑85). | Capacity check (`SELECT COUNT(*)`) and `INSERT … ON CONFLICT DO NOTHING` are **not atomic**. |
| **CHESS‑011** | No Email Verification | `src/routes/auth.js` – registration creates account immediately. |
| **CHESS‑012** | No Refresh‑Token Flow | Auth routes only issue an access token with a fixed expiry (`7d`). |
| **CHESS‑013** | No Password‑Reset Endpoint | No route to reset forgotten passwords. |
| **CHESS‑014** | Error Messages Leak Info | `socketAuthMiddleware` returns `"Invalid authentication token"` on any verification failure. |
| **CHESS‑015** | Development Stack Traces | Error handler (`server.js` line 119) logs full stack in non‑production. |

### Severity Classification

| Severity | Definition |
|----------|------------|
| **CRITICAL** | Allows full system compromise or complete loss of data. |
| **HIGH** | Enables privileged access or large‑scale abuse. |
| **MEDIUM** | Can affect confidentiality/integrity for specific users or cause denial‑of‑service. |
| **LOW** | Minor usability or informational issues. |

| ID | Severity |
|----|----------|
| CHESS‑001 | **CRITICAL** |
| CHESS‑002 | **HIGH** |
| CHESS‑003 | **HIGH** |
| CHESS‑004 | **MEDIUM** |
| CHESS‑005 | **MEDIUM** |
| CHESS‑006 | **MEDIUM** |
| CHESS‑007 | **HIGH** |
| CHESS‑008 | **MEDIUM** |
| CHESS‑009 | **HIGH** |
| CHESS‑010 | **MEDIUM** |
| CHESS‑011 | **LOW** |
| CHESS‑012 | **MEDIUM** |
| CHESS‑013 | **LOW** |
| CHESS‑014 | **LOW** |
| CHESS‑015 | **LOW** |

---

## 4. Multiplayer Findings (Socket.io)

| Event / Endpoint | Authorization Required? | Current Check(s) | Possible Abuse | Severity |
|------------------|--------------------------|-------------------|----------------|----------|
| `create_room` | **None** (guest allowed) | Clean player name; optional `socket.userId`. | Spam creation of rooms (DoS). | MEDIUM |
| `join_room` | **None** (guest allowed) | Checks `activeRooms` existence, capacity, status, and **DB UPDATE** with `black_user_id IS NULL`. | Guest can join as black, may fill room with null‑ID players; race‑free DB guard prevents double‑join. | LOW |
| `make_move` | **Yes** – socket must be a participant (`room.players.find(p.id===socket.id)`). | Verifies turn, validates move via `chess.js`, persists move+board FEN in a DB transaction. | If client tampers with `roomId` or sends malformed move, server rejects. | LOW |
| `game_over` | **Yes** – player must be part of the room. | Re‑derives result from server’s chess engine; ignores client‑sent result. | None (server‑authoritative). | LOW |
| `request_rematch` | **Yes** – participant required. | No further validation; simply broadcasts `rematch_requested`. | Spam of rematch requests (annoyance). | LOW |
| `accept_rematch` | **Yes** – participant required. | Votes stored in `room.rematchVotes`. When both vote, a **new** game row is created in DB. | Possible denial‑of‑service if many accept calls, but DB guard ensures uniqueness. | LOW |
| `resign` | **Yes** – participant required. | Calls `finalizeGame` with winner set to opponent. | None. | LOW |
| `send_message` | **Yes** – participant required. | Trims to 200 chars; no sanitisation needed because text is rendered as plain text. | None. | LOW |
| `disconnect` | **Yes** – participant‑related clean‑up. | Finalises game with `disconnect` result; removes player from `room.players`. | If disconnect occurs during a race, finalisation may be attempted twice – guarded by `room.finalizing` flag. | LOW |

**Overall**: The socket layer is **server‑authoritative** for game state. The main concerns are *guest abuse* (room creation) and *state loss on server crash*.

---

## 5. Database Findings

| Table | Key Observations | Constraints / Indexes | Potential Issues |
|-------|------------------|-----------------------|------------------|
| `users` | Columns: `id, username, email, password_hash, avatar_url, bio, elo_rating, created_at, updated_at`. | Unique on `username`, `email`; index on `elo_rating`. | No `NOT NULL` on `avatar_url`/`bio` (acceptable). |
| `scores` | Stores game results; optional `game_id`. | Indexes on `winner`, `moves`, `user_id`, `played_at`. | No constraint preventing duplicate scores for same game (but `game_id` may be NULL). |
| `games` | Core game row; `room_id` unique, foreign keys to `users`. `status` default `in_progress`. | Indexes on `room_id`, `white_user_id`, `black_user_id`, `status`. | No `UNIQUE` on `(room_id, status)` – not needed. |
| `moves` | One row per move; foreign key to `games`. | Composite index `(game_id, move_number)`. | No `UNIQUE` on `(game_id, move_number)` – could allow duplicate move numbers if buggy client. |
| `achievements` / `user_achievements` | Simple badge tables. | PK on `key`; unique `(user_id, achievement_key)`. | No issues. |
| `friendships` | `requester_id`, `addressee_id`, `status`. | `UNIQUE (requester_id, addressee_id)`, `CHECK (requester_id <> addressee_id)`. | No `UNIQUE` on the inverse pair, but the `CHECK` plus unique pair prevents duplicate both directions (the query checks both directions). |
| `tournaments` | `max_players` limited by UI to 4, 8, 16. | Indexes on `room_id`, `status`. | No constraint preventing `max_players` being set to arbitrary values via direct DB write (but API validates). |
| `tournament_players` | Links users to tournaments. | `UNIQUE (tournament_id, user_id)`. | **Race condition**: capacity limit checked before insert (non‑atomic). |
| `tournament_matches` | Stores bracket matches. | `UNIQUE (tournament_id, round, position)`. | No checks that `player1_id` ≠ `player2_id`; UI prevents, but DB does not. |

**Transaction Safety** – Critical writes (`Game.createWithClient`, `Game.joinBlackByIdWithClient`, `Move.recordWithClient`, `Game.finishByIdWithClient`) are all wrapped in `runInTransaction`, guaranteeing atomicity and row‑level locks.

**Missing Constraints** – `tournament_players` lacks a DB‑level check on player count; must be enforced at application level or via a trigger.

---

## 6. Reliability Findings

| Issue | Description | Impact | Recommended Fix |
|-------|-------------|--------|----------------|
| **In‑memory room loss** | `activeRooms` cleared on server restart → all multiplayer sessions abort. | Users can lose games; service unavailable during rolling updates. | Persist room metadata (e.g., in Redis) and recover on start‑up. |
| **Potential double finalisation** | `finalizeGame` checks `room.status` and `room.finalizing`. Edge case when two disconnect events fire almost simultaneously may still cause race. | Duplicate DB updates (error `ALREADY_FINALIZED`). | Keep the guard as is; add idempotent DB logic (e.g., ignore already‑finalised rows). |
| **No graceful shutdown** | `process.exit(1)` on DB connection failure aborts the whole service without fallback. | Outage on transient DB connectivity. | Implement reconnect retries with back‑off before exiting. |
| **Guest‑only rooms** | No limit on number of guest rooms. | Could be abused to exhaust memory. |
| **Server‑side crash handling** | No `process.on('uncaughtException')` or `unhandledRejection` logging/cleanup. | Crashes may leave dangling DB rows (`in_progress` games). |

---

## 7. Testing Gaps

| Area | Current Coverage | Missing Tests | Risk |
|------|------------------|--------------|------|
| **REST API** | Basic unit tests for routes exist (see `coverage`). | No tests for auth rate‑limiting, error paths (e.g., malformed payload). | Medium – could miss security regressions. |
| **Socket.io** | No automated tests for socket events. | No tests for `make_move`, `join_room` race conditions, disconnect handling, rematch flow. |
| **Tournament Join** | Tested via API integration? Not in repo. | No tests for concurrency to prove capacity limit. |
| **File Upload** | No tests for avatar upload validation (MIME/content). |
| **ELO Calculation** | `utils/elo.js` is small; no tests for edge cases (e.g., extreme rating gaps). |
| **Replay & Move Recording** | No tests for `Move.recordWithClient` order & idempotency. |
| **Security Headers** | Helmet integrated but no tests that CSP headers are present. |
| **Rate Limiting** | Not exercised in tests. |

---

## 8. Performance Findings

| Observation | Impact | Recommendation |
|--------------|--------|----------------|
| **N+1 queries** – Leaderboard endpoints fetch users via separate queries (`User.getTopByElo`) but index usage mitigates. | Minimal for current load. | Keep indexes; consider caching hot leaderboard. |
| **Full‑table scans** – `Game.getUserForUpdateWithClient` locks user rows during ELO settlement; low contention as only on game end. | Acceptable. |
| **In‑memory board updates** – Chess engine runs on each move; cheap for single games but could become CPU‑bound with many concurrent games. | Profile CPU usage; optionally move engine to a worker pool. |
| **Avatar serving** – Static files served directly; no CDN. | May increase bandwidth on high traffic. |
| **Socket broadcast** – `io.to(roomId).emit` sends full board state each move (FEN string). | Small payload, fine. |

---

## 9. Code Quality Findings

| Issue | File | Description |
|-------|------|-------------|
| **Duplicate error handling** | `gameSocket.js` – multiple `socket.emit("error")` calls with similar messages. | Extract to a helper to keep messages consistent. |
| **Unused imports** | Several UI components import `Icon` but never use it (e.g., `LeaderboardModal` after refactor). | Run a linter to clean dead code. |
| **Mixed language comments** (Arabic & English) – may hinder contributions from non‑Arabic speakers. | Overall codebase. | Consider adding English equivalents or a translation guide. |
| **Long functions** – `finalizeGame` and `make_move` exceed 100 LOC. | `gameSocket.js`. | Split into smaller helpers for readability. |
| **Magic numbers** – `generateRoomId` uses 6‑character base‑36 random ID. | `gameSocket.js`. | Document collision probability; consider `nanoid`. |
| **Hard‑coded URLs** – `uploadAvatar` builds URL using `req.protocol` & `req.get("host")`. | `auth.js`. | Acceptable, but may break behind reverse proxies. |
| **Error messages expose internals** – `logger.error(err.message)` may log sensitive data. | Various. | Ensure sensitive fields (passwords) are never logged. |

---

## 10. Complete Issue Registry

| ID | Severity | Category | File / Function / Endpoint / Event | Problem | Why it matters | Attack / Failure Scenario | Current Behaviour | Expected Behaviour | Recommended Fix | Required Tests |
|----|----------|----------|-------------------------------------|---------|----------------|--------------------------|-------------------|-------------------|----------------|----------------|
| CHESS‑001 | CRITICAL | Authentication | `src/middleware/auth.js` & `src/socket/socketAuth.js` – JWT verification fallback to `"chess-secret-key"` | Hard‑coded secret used if `JWT_SECRET` missing | Allows token forgery, full account takeover | Attacker crafts a JWT with admin `id`, `username`; server accepts it | Accepts any token signed with default secret | Abort start‑up if `JWT_SECRET` undefined; require env var | Add unit test that token verification fails when secret is missing |
| CHESS‑002 | HIGH | Front‑end Security | `src/utils/authStorage.js` – token stored in `localStorage` | Tokens readable by any script → XSS leads to token theft | XSS (if ever introduced) gives attacker API access | Malicious script reads `localStorage.getItem('chess_token')` and reuses it | Token stored client‑side | Store token in **httpOnly** secure cookie or use **WebAuthn**; if localStorage necessary, enforce CSP and XSS sanitisation | Add integration test that token is not exposed via DOM |
| CHESS‑003 | HIGH | Configuration | `docker-compose.yml` – default `JWT_SECRET` value is committed | Same as CHESS‑001 | Same | Same | Same | Same as CHESS‑001 |
| CHESS‑004 | MEDIUM | CORS / CSRF | `src/server.js` – CORS `origin: process.env.FRONTEND_URL || "*"` | Wildcard origin permits any site to make authenticated requests (if token stolen) | Facilitates CSRF‑style misuse when token is compromised | Malicious site reads token via XSS → sends API calls | Allows any origin | Restrict to explicit whitelist; reject if env var missing |
| CHESS‑005 | MEDIUM | Security Headers | Helmet used without CSP header | Missing CSP enables XSS via uploaded SVG | Malicious SVG could execute script | Upload SVG (if bypassed) → rendered in profile → script runs | No CSP | Add CSP via Helmet (`contentSecurityPolicy: true`) |
| CHESS‑006 | MEDIUM | Rate Limiting | Global limiter `100/15 min` on `/api/*` | No per‑endpoint limit on `/auth/login`; password‑spraying possible | Brute‑force login attempts | Attack script tries thousands of passwords per minute | Allowed until global limit reached (still high) | Enforce tighter limit on auth routes (e.g., 5 attempts per IP per minute) |
| CHESS‑007 | HIGH | File Upload Validation | `src/middleware/upload.js` – only checks file extension | Malicious files (polyglot images/SVG) can be stored & served | XSS via avatar image | Upload an SVG containing `<script>` → displayed in profile → script execution | Extension check only | Perform MIME type and content inspection (`file-type` lib) and reject non‑image binaries |
| CHESS‑008 | MEDIUM | Avatar Access Control | `/uploads` static route – no auth, predictable filenames | Anyone can enumerate avatars, potentially map usernames to images | Enumerate user IDs, harvest avatars | Guess filenames (`user{id}-{timestamp}.png`) | Anyone can request any avatar URL |
| CHESS‑009 | HIGH | Reliability / Scalability | `src/socket/gameSocket.js` – `activeRooms` in memory only | Server restart loses all in‑progress multiplayer games | Users lose progress, service unavailable during rolling updates | Crash or restart → all rooms cleared; clients receive “Room not found” | Memory‑only | Persist rooms in Redis or rebuild from DB on start‑up |
| CHESS‑010 | MEDIUM | Concurrency | `models/Tournament.js` → `join` capacity check | Count check & INSERT are not atomic | Over‑booking tournament beyond `max_players` | Simultaneous joins exceed limit | May allow > maxPlayers |
| CHESS‑011 | LOW | Account Hygiene | No email verification on registration | Fake accounts can be mass‑registered | Spam, inflated leaderboards | Bot registers many accounts with disposable emails | Account created instantly |
| CHESS‑012 | MEDIUM | Token Lifecycle | No refresh‑token flow; single access token lives up to 7 days | Long‑lived token increases impact of theft | Stolen token usable for a week |
| CHESS‑013 | LOW | Account Recovery | No password‑reset endpoint | Users locked out if they forget password |
| CHESS‑014 | LOW | Error Messages | `socketAuthMiddleware` returns generic `"Invalid authentication token"` |
| CHESS‑015 | LOW | Development Leakage | Stack traces exposed when `NODE_ENV != "production"` |

---

## 11. Recommended Fix Sequence (Phased)

| Phase | Target Issues | Rationale |
|-------|---------------|-----------|
| **Phase 0 – Critical blockers** | CHESS‑001, CHESS‑002 (JWT secret), CHESS‑009 (in‑memory rooms), CHESS‑007 (avatar validation) | These expose the system to full compromise or data loss. |
| **Phase 1 – Security & Authorization** | CHESS‑003 (token storage), CHESS‑006 (auth rate‑limit), CHESS‑004 (CSP), CHESS‑005 (CORS), CHESS‑010 (tournament join race), CHESS‑008 (avatar access) |
| **Phase 2 – Game Integrity** | CHESS‑009 (room persistence), CHESS‑014 (disconnect race guard improvement) |
| **Phase 3 – Database Consistency** | CHESS‑010 (tournament capacity atomicity), add DB constraint/trigger on tournament player count, consider unique `(game_id, move_number)` constraint |
| **Phase 4 – Reliability & Observability** | Add global error handlers, graceful shutdown, health‑check enhancements, logging sanitisation |
| **Phase 5 – Testing** | Write socket integration tests, concurrency tests for tournament joins, file‑upload security tests, rate‑limit tests |
| **Phase 6 – Performance & Scaling** | Move `activeRooms` to Redis, add caching for hot leaderboards, configure CDN for static assets |
| **Phase 7 – Code Quality** | Refactor large socket handlers, remove dead code, enforce linting, add documentation for mixed‑language comments |

---

## 12. Files Requiring Changes (ordered by phase)

| Phase | File(s) to modify |
|-------|-------------------|
| **0** | `Chess-Backend/src/middleware/auth.js` – enforce mandatory `JWT_SECRET`; abort if missing. <br> `Chess-Backend/src/socket/socketAuth.js` – same change.<br> `Chess-Backend/src/middleware/upload.js` – add MIME‑type/content inspection (e.g., `file-type`). |
| **1** | `Chess-Backend/src/server.js` – tighten CORS to explicit whitelist; add CSP via Helmet.<br> `Chess-Backend/src/routes/auth.js` – add rate‑limit middleware for login/registration.<br> `Chess-Frontend/src/utils/authStorage.js` – consider moving token to httpOnly cookie (requires backend changes). |
| **2** | `Chess-Backend/src/socket/gameSocket.js` – persist room state to Redis or DB; add reconnect handling.<br> `Chess-Backend/src/socket/gameSocket.js` – ensure `room.finalizing` flag robust against rapid disconnects. |
| **3** | `Chess-Backend/src/models/Tournament.js` – wrap join in a DB transaction that checks player count (`SELECT ... FOR UPDATE`) before INSERT.<br> `Chess-Backend/src/models/Move.js` – add unique constraint on `(game_id, move_number)` if desired. |
| **4** | `Chess-Backend/src/server.js` – add `process.on('uncaughtException')` & `unhandledRejection` handlers that mark in‑progress games as `abandoned`.<br> `Dockerfile` / entrypoint – ensure `NODE_ENV=production` is set in all containers. |
| **5** | Add tests under `Chess-Backend/tests/` for socket events (using `socket.io-client`).<br> Add concurrency tests for tournament joins (`supertest` with parallel requests). |
| **6** | Add Redis integration (`npm i redis`) and modify `gameSocket.js` to store/retrieve rooms from Redis.<br> Add CDN config for static `/uploads` and frontend build assets. |
| **7** | Refactor large functions (`finalizeGame`, `make_move`) into smaller modules.<br> Run ESLint/Prettier, remove unused imports. |

---

## 13. Areas With No Confirmed Issues

| Area | Confirmation |
|------|----------------|
| **Chess move validation** | `chess.js` is used server‑side; all moves are validated against the engine. |
| **SQL injection** | All DB queries use parameterised placeholders (`$1`, `$2`, …). |
| **Password storage** | bcrypt with 12 rounds – strong. |
| **ELO calculation** | Uses standard formula; no overflow concerns. |
| **Leaderboard queries** | Proper indexes (`idx_scores_winner`, `idx_users_elo`). |
| **Friendship logic** | Unique constraint and checks prevent duplicate or self‑friend requests. |
| **Tournament match creation** | Logic guards against invalid winner IDs. |
| **Error handling** | Generic 500 in production hides stack traces. |
| **Static asset sanitisation** | All images served with correct content‑type; no HTML rendering of user data. |
| **Helmet usage** | Basic security headers (X‑Frame‑Options, X‑XSS‑Protection, etc.) are present. |

---

*Prepared by Claude Code, based entirely on the current repository contents (as of 2026‑09‑17). No code modifications were performed during this audit.*