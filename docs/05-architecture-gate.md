# Architecture Gate / Pre-Implementation Review

Date: 2026-09-22 · Status: **GATE — no code/infra changes authorized until reviewed**
Supersedes conflicting ordering in `docs/04-implementation-roadmap.md` (see §7).
No application code modified. No infrastructure created. No legacy files deleted.

New finding since discovery: `Chess-Backend/src/socket/socketAuth.js` is **dead code**
(`gameSocket.js` uses its own cookie+DB `socketAuthentication`) and contains a weak fallback
`process.env.JWT_SECRET || "chess-secret-key"` — a value the security module explicitly forbids.
Disposition: delete the file in the first hygiene PR (it is unreachable; deletion is behavior-neutral).
Recorded as risk R-11 in `docs/01-reverse-engineering-report.md`.

---

## 1. Socket.io scalability — full analysis

### 1.1 Current architecture constraint (proven from code)

| # | Process-local element | Location | What breaks with replicas ≥ 2 |
|---|---|---|---|
| 1 | `activeRooms` Map (room lookup, join, status) | `gameSocket.js:12` | Player A on pod-1 creates room; player B on pod-2 gets "Room not found". Split-brain room tables. |
| 2 | `io.to(room).emit(...)` broadcasts | all handlers | Moves/chat/game-end reach only sockets on the *same* pod. Cross-pod games go silent. |
| 3 | `room.operation` promise chain (serialization) | `roomTask()` | Per-room mutex exists per pod, not globally. Partially mitigated by DB `SELECT … FOR UPDATE` in `persistMoveAtomic` (moves stay legal), but status checks, rematch flow, and disconnect handling can race across pods. |
| 4 | `players[].id` = `socket.id` (ephemeral) | join/move/resign handlers | Socket IDs are meaningless across pods; membership/turn checks fail for the remote player. |
| 5 | `rematchVotes: Set<socket.id>` | rematch handlers | Two votes on two pods never reach size 2 → rematch deadlocks. |
| 6 | `express-rate-limit` MemoryStore | `server.js` limiters | Limits enforced N× (once per pod). Login/email brute-force budgets multiply by replica count. |
| 7 | Avatar files on local disk | `middleware/upload.js` `fs.writeFile` | Write lands on pod-A volume; read via pod-B → 404. Also: N divergent upload stores. |
| 8 | `rebuildActiveRooms()` on every boot | `gameSocket.js` + `server.js` startup | Every replica full-scans recoverable games and builds a full room table. Convergent for reads (DB is truth for FEN/moves) but O(N·games) waste; N rooms each believe they own the game. |
| 9 | Already shared (no change needed) | `models/Game.js`, `services/tokens.js`, `middleware/auth.js` | Move legality mutex (`FOR UPDATE` + turn check), finalization idempotency (`status='in_progress'` guard → `settled:false`), JWT verify + DB `session_version`. **The data layer was written correctly for concurrency; only the realtime fan-out and identity layers are local.** |

Verdict: `replicas: 1` is a **correct interim constraint**, not an architecture. §1.2 defines the exit.

### 1.2 Target scalable architecture (exact changes)

1. **Socket.io Redis adapter** (`@socket.io/redis-adapter` + `redis` client): inter-pod pub/sub so
   `io.to(room).emit` fans out cluster-wide. Redis holds *ephemeral pub/sub only* — no game truth moves to Redis.
2. **Sticky sessions AND adapter** (both, not either/or): adapter solves fan-out; stickiness solves
   transport affinity (polling handshake → upgrade must hit one pod). Implementation: ALB target-group
   stickiness (`stickiness.enabled=true`, duration ~1h) scoped to the backend target group. Cookie name
   (`AWSALBCORS`/custom) is independent of `SameSite=Strict` auth cookies — no conflict.
   > SUPERSEDED by Wave 7 Phase 4: websocket-only transports remove the affinity
   > requirement, so the stickiness half is REJECTED (rationale: ADR-003 amendment;
   > build: `wave7-baseline.md` §Phase 4; enforcement: checker §11 bans `stickiness`).
3. **Shared rate limiting**: `rate-limit-redis` store on the same Redis; login/register/email/refresh
   limiters become global. Keep per-route windows unchanged.
4. **Identity by `userId`, not `socket.id`**: `rematchVotes: Set<userId>`; membership keyed by `userId`
   with `socket.id` as a transient attachment. Membership itself stays in the adapter-visible room
   (Socket.io rooms become cluster-aware via the adapter).
5. **Lazy room hydration**: on `join_room`, if room absent locally, load from DB (`findByRoomId` +
   moves + FEN) instead of erroring; keep `rebuildActiveRooms()` as boot warm-up only, or gate it
   behind a leader-election/once-per-deploy Job. Lazy-load is the simpler correct fix.
6. **Avatars → S3** (see §6): validation pipeline (`hasCompleteContainer` → Sharp → WebP) unchanged;
   only the sink changes (`fs.writeFile` → `PutObject`). Reads become auth-checked presigned GETs
   (or CloudFront + signed URLs later).
7. **Graceful shutdown for rolling deploys** (extends the already-good SIGTERM path):
   `terminationGracePeriodSeconds: 60`, `preStop: sleep 15` (ALB deregistration delay alignment),
   existing order kept: fail readiness → `io.close()` → close HTTP → `drainRoomOperations()` →
   `pool.end()`. Client already auto-rejoins on `connect` (`useMultiplayer.js` `onConnect`) —
   rolling restarts surface as brief `opponent_disconnected` + rejoin, not lost games (DB is truth).
8. **HPA + PDB (only after 1–7)**: backend HPA `minReplicas: 2, maxReplicas: 6` on CPU/custom
   `socket_connections`; `PodDisruptionBudget minAvailable: 1`; `RollingUpdate maxUnavailable: 0,
   maxSurge: 1`. Frontend HPA from day one of EKS (stateless). **Backend PDB with 1 replica is
   forbidden** (blocks all drains) — this is why HPA/PDB ship in the scale-out wave, not before.

### 1.3 Constraint vs target + transition point

```text
NOW (compose + early EKS):   backend replicas = 1, Recreate strategy, NO HPA, NO PDB on backend.
                             Correct, documented in ADR-002, enforced by chart validation.

SCALE-OUT GATE (dedicated wave, app changes behind flags, staging-proven):
  Redis adapter + sticky ALB + redis rate limits + userId identity + lazy hydration
  + S3 avatars + draining + HPA/PDB  →  backend replicas ≥ 2 allowed.
```

The transition is a **named gate between staging-GitOps-proven and prod-cutover** (§7, Wave 7):
it needs staging Redis+RDS to test against, observability to see cross-pod failure, and ArgoCD
one-click rollback because it is the only wave that changes application behavior. It must not
be folded into "deploy to EKS" — that ordering caused the legacy manifests' `replicas: 2` bug.

---

## 2. 2026 architecture validation (per component)

Challenge applied to every item: need, problem, dependency, burden, timing, simpler alternative, fit.

| Component | Why / problem solved | Dependency + burden | Timing | Simpler alternative (rejected why) | Fit for this chess app |
|---|---|---|---|---|---|
| **EKS** | Managed K8s: declarative deploys, rolling updates, autoscaling, IAM-integrated workloads | Control plane ~$73/mo; version upgrades; add-on lifecycle (ALB controller, ESO) | Staging first (Wave 4–5); prod only after scale gate | Stay on Compose + standby host: rejected as *end state* (no declarative CD, manual failover, team doesn't scale), **accepted as interim** (ADR-001) | Yes as target: 2-service app is small, but GitOps+HA+team workflows need it |
| **RDS PostgreSQL 16** | Backups, PITR, Multi-AZ failover, KMS, Enhanced Monitoring without operating Postgres | Cost (Multi-AZ prod); parameter-group/upgrade management | With staging EKS (real managed DB from first cluster day) | In-cluster Postgres/StatefulSet: rejected (you own backups/failover; legacy `deployment-postgres.yml` proved the trap) | Yes — DB already the concurrency source of truth; deserves managed treatment |
| **ElastiCache Redis** | Socket.io adapter pub/sub + shared rate limits (+ later: cache/queues) | Cost even idle; failover testing; client (re)connect logic | **Only at Scale-Out Gate** — deploying earlier burns money for zero traffic benefit | Self-hosted Redis on EKS: rejected for prod (you own failover/persistence); accepted implicitly for dev via compose service | Yes, scoped: ephemeral pub/sub + limits, never game truth |
| **ECR** | Private registry, immutable tags, scan-on-push, lifecycle rules, IAM/OIDC native | Per-repo config; replication if multi-region (deferred) | Wave 3, before first cluster deploy | Docker Hub: rejected (rate limits, no OIDC, public-by-default footguns) | Yes |
| **Terraform** | Reproducible VPC/EKS/RDS/ECR/IAM; reviewable infra changes; state locking | State hygiene; provider upgrades; plan-review discipline | Wave 4 (after CI gates so IaC is scanned from birth) | ClickOps/CDK: rejected (no drift control / team already TF-shaped) | Yes |
| **GitHub Actions** | CI + release already connected to the repo; OIDC to AWS; no servers | Workflow sprawl risk (cap: `ci.yml`, `security.yml`, `release.yml`, `terraform-*.yml`) | Wave 2 (first, gates protect everything after) | Jenkins: retired, see §3 | Yes |
| **GitHub OIDC** | Short-lived creds; no static AWS keys in secrets; CloudTrail-attributed | One-time IdP + role trust-policy setup | With ECR/Terraform (Wave 3–4) | Static `AWS_*` secrets: rejected (rotation burden, leak blast radius) | Yes |
| **Argo CD** | Declarative CD, drift detection, one-click rollback, audit trail, env promotion | Controller HA + upgrades; repo-creds/RBAC hygiene | Wave 5 (staging), after chart + GitOps repo exist | `kubectl apply` from CI: rejected (CI gets cluster-admin, no drift correction, no audit UI) | Yes |
| **Kyverno** | Admission guardrails (`verifyImages` Cosign, require probes/limits/seccomp, deny `:latest`/privileged) | Policy testing; risk of blocking legit deploys if over-scoped | Install early (Wave 5, **audit mode**), enforce after staging soak | OPA/Gatekeeper: rejected (Rego burden for a 2-service app); PSS alone: insufficient (no image verification) | Yes, minimal set (≤5 policies), expand only on incident |
| **Grafana Alloy** | Single collector: pod logs→Loki + metrics + OTLP-ready | One more agent to version-pin | With observability wave (after staging serves traffic) | Promtail + ad-hoc sidecars: rejected (two agents, no OTLP path); CloudWatch-only: rejected (no unified app+infra view, query cost) | Yes |
| **Prometheus (+stack)** | Metrics, alerting rules, SLO burn | Retention/storage sizing; rule maintenance | Same wave as Alloy | CloudWatch metrics: rejected (cost at label cardinality, weaker PromQL/alert UX) | Yes (kube-prometheus-stack, internal only) |
| **Grafana** | Dashboards for app/K8s/RDS/ingress; Loki + Prometheus in one UI | SSO/OAuth2-proxy + secret management | Same wave | — (no credible alternative; paired with stack) | Yes |
| **Loki** | Cheap log aggregation (S3-backed), label-linked to metrics | Index label discipline (cardinality!) | Same wave | Elasticsearch: rejected (heavy, costly for this volume); CloudWatch Logs for *workloads*: rejected (see Alloy) | Yes, with label budget |
| **OpenTelemetry** | Vendor-neutral traces/context propagation | SDK + collector + sampler tuning; real cost for 2 hops | **Deferred**: ship trace-ready (`traceparent` propagation, `request_id` in JSON logs); full SDK only when a 3rd hop (Redis/cache/worker) lands | Logs+metrics correlation: accepted as sufficient today | Not yet — honest deferral, revisit trigger defined |
| **Cosign (keyless)** | Image signatures without key management (Fulcio/Rekor); `verifyImages` target | Rekor/Fulcio availability at build time | Sign in Wave 3 (cheap); **enforce** in prod only after staging soak | Skip signing: rejected (supply-chain proof is near-free in CI) | Yes |
| **SBOM (Syft)** | Provenance + vuln triage + (later) VEX; artifact per release | Artifact storage (small) | Wave 3 with release | Skip: rejected (regulators/customers increasingly require it; generation is seconds) | Yes |
| **GuardDuty EKS Protection** | Runtime threat detection without operating Falco | Per-vCPU cost; finding triage | With prod EKS | Self-hosted Falco: rejected (rule tuning burden for a small team) | Yes, low-burden runtime signal |

Net change from `docs/02`: OTel explicitly deferred (was already leaning so — now decided),
Falco explicitly rejected in favor of GuardDuty, RDS Proxy explicitly deferred (app pool suffices;
revisit trigger: connection exhaustion), CloudFront deferred until traffic justifies.

---

## 3. CI/CD architecture validation + Jenkins ruling

### 3.1 Responsibility contract (final)

```text
GitHub (platform)         → source of truth, branch protection, CODEOWNERS, secret push-protection,
                            Dependabot alerts, environments (staging/prod approvals)
GitHub Actions: ci.yml    → per-PR gates: secrets, SAST, SCA, tests, Dockerfile lint,
                            image build+scan, SBOM (unsigned), IaC scan, Helm/K8s validation.
                            REQUIRED status check. No deploys, no pushes, no cloud mutation.
GitHub Actions: security.yml → scheduled DAST vs staging (ZAP baseline), npm audit, dep review,
                            secret rotation reminders. Advisory + issues, blocks nothing per-PR.
GitHub Actions: release.yml → on main: build → scan (gate) → SBOM+attest → Cosign sign →
                            push ECR (:sha + digest) → commit-back digest to GitOps repo (staging).
Argo CD                   → ONLY deployer to clusters. Polls GitOps repo, diffs, syncs
                            (auto in staging, manual promotion to prod), self-heal, rollback.
Terraform workflow        → plan on PR (comment), apply on main-merge with environment approval.
                            Only writer of AWS infra. Never touches workloads.
```

Build-once-promote-digest: staging and prod run the **same digest**; promotion never rebuilds.

### 3.2 Where would Jenkins fit? (retired — with precise conditions)

Jenkins would own *self-hosted execution* (build agents on EKS/EC2) if: air-gapped/compliance
mandate, custom hardware builders, or GitHub-hosted minutes cost explosion. None hold here:
repo is GitHub-native, builds are `npm`+`docker` (minutes-cheap), secrets are safer via OIDC
than a Jenkins credential store on a public `t3.2xlarge`. The legacy Jenkinsfiles' *stage list*
(Sonar→Semgrep-equivalent, OWASP DC→Trivy, Trivy, Slack) is preserved as requirements input;
their *machinery* (controller, plugins, static creds, `YOUR_*` placeholders) is archived to
`legacy/` with a rationale README. **Resurrection trigger**: documented org mandate or sustained
Actions spend > Jenkins TCO for 3 months — then Jenkins runs *ephemeral agents only*, never owns deploy.

---

## 4. GitOps model validation (final)

| Question | Decision |
|---|---|
| Source code + Dockerfiles | **App repo** (this repo). Dockerfiles version with the code they build. |
| Helm chart source | **App repo** (`helm-chess/`), versioned with code; packaged + pushed as OCI artifact to ECR on release (immutable chart version = app version). |
| Environment values + image digests | **Separate `chess-gitops` repo**: `apps/chess/{base,staging,prod}/` (values + digest pin per env). Separate repo = promotion PRs, distinct RBAC (devs merge code; release approvers merge prod promotion), ArgoCD polls a small deployment-only history. |
| Image version updates | `release.yml` commits digest bump to `chess-gitops:staging` (commit-back, auditable). **No ArgoCD Image Updater** (extra controller for what is one `yq`+commit step). |
| Promotion dev→staging→prod | dev = compose/local (no GitOps). staging auto-syncs on commit. prod = PR `staging→prod` values copy (same digest) + required reviewer + `security.yml` DAST green → merge → manual ArgoCD sync (auto-sync OFF in prod). |
| Rollback | `git revert` the digest commit (preferred, audited) or ArgoCD revision rollback (emergency, then reconcile Git within 1h — Git stays truth). Soak metric: prod rollback < 5 min in drill. |
| ArgoCD reconciliation | Poll GitOps repo (3 min) + webhook for immediacy → `git diff` vs live → out-of-sync → sync in wave order (namespace → ESO secrets → migration Job PreSync → backend → frontend → ingress) → health checks (`readiness` gates) → self-heal hourly corrects manual `kubectl` drift (alert on self-heal events). |

---

## 5. Security model validation — exact tool per control (no overlaps)

```text
Developer      → pre-commit: gitleaks protect (secrets) + editorconfig/eslint (hygiene)
GitHub         → branch protection + CODEOWNERS + secret push-protection + Dependabot alerts (platform, no agent)
PR             → Gitleaks Action (secret scan)            [1 tool]
               → Semgrep (SAST, JS/React rules, SARIF)    [chosen over CodeQL: no GHAS requirement, fast]
               → Trivy fs (SCA authoritative) + npm audit (fast signal; different cost/latency tier, not overlap)
               → Jest unit + PG integration + Playwright e2e (tests)
               → Hadolint (Dockerfile lint)               [lint axis]
               → Trivy config (IaC + compose+K8s misconfig; replaces deprecated tfsec)
               → tflint (Terraform logic)                 [logic axis, not vuln axis]
               → kubeconform + helm lint + Kyverno CLI test (K8s validity + policy pre-check)
Build          → docker build (pinned digests, SBOM-ready labels)
Image          → Trivy image HIGH/CRITICAL = fail         [vuln axis]
SBOM           → Syft (SPDX-JSON) → attach + Cosign attest
Signing        → Cosign keyless (Fulcio/Rekor)
Registry       → ECR immutable tags + scan-on-push (defense in depth) + lifecycle purge
CD             → ArgoCD (least-privilege project roles, signed commits for prod promotion)
Admission      → Kyverno: verifyImages (prod enforce / staging audit→enforce), require digests,
                 probes+limits, seccomp, drop ALL caps, deny :latest/privileged/hostPath (≤5 policies)
Cluster        → PSS restricted, RBAC least-privilege, default-deny NetworkPolicy + explicit allows
                 (incl. backend→RDS 5432, SMTP 587, DNS TCP+UDP 53 — legacy gap fixed),
                 ESO→Secrets Manager (KMS), IRSA, GuardDuty EKS Protection (runtime)
Secrets        → Secrets Manager (rotation: RDS auto, JWT manual-with-dual-secret window — see §6)
Observability  → Security alerts: ArgoCD sync-fail, Kyverno violations, GuardDuty findings,
                 ECR CRITICAL on re-scan, cert expiry, 5xx/error-budget burn
```

Explicitly dropped: OWASP Dependency-Check (Trivy covers), tfsec (deprecated → Trivy config),
Checkov (Trivy config + tflint suffice; revisit on compliance need), Falco (→GuardDuty),
ArgoCD Image Updater (§4), SonarQube server (Semgrep; no JVM to operate).

---

## 6. Production data architecture validation

### 6.1 PostgreSQL → RDS

- Staging: `db.t4g.micro`, Single-AZ, gp3 autoscaling, KMS alias key, deletion protection ON (prod)
  / OFF-then-snapshot (staging), PITR 7d both.
- Prod: `db.t4g.small` start (vertical headroom documented), **Multi-AZ**, PITR 7d, Enhanced Monitoring
  60s, Performance Insights on.
- Connectivity: private subnets only; SG allows 5432 from EKS node SG + migration Job only;
  `DB_SSL=true` + RDS CA bundle via ESO (app already supports `DB_SSL_CA` — zero code change).
- Pooling: app `pg` pool `max: 10` per pod; max pods 6 + migration job → size `max_connections`
  ≥ 100 headroom. **RDS Proxy deferred** (cost + yet-unproven need); revisit trigger: connection
  errors or `remaining connection slots` alarms.
- Migrations: same `run.js` image as ArgoCD **PreSync Job** (`backoffLimit: 3`, `activeDeadlineSeconds:
  600`); advisory lock preserves single-writer; forward-only policy; readiness still requires `007`
  row (then per-release: require latest known migration — parameterize, don't hardcode `007` forever).
- Rotation: RDS master via Secrets Manager **automatic rotation** (single-user, scheduled window);
  app DB user: dual-password window (create `app_user_next`, migrate ESO secret, revoke old) —
  runbooked, drilled in staging first.
- Backups/restore: automated snapshots + final snapshot on delete (prod); restore drill quarterly
  into `chess_restore_verify` (same pattern as `scripts/restore-postgres.sh`, RDS-adapted).

### 6.2 uploads_data → S3 (the statelessness unlock)

- Bucket: private, SSE-KMS, versioning on, lifecycle (noncurrent → Glacier after 90d; prod),
  Block Public Access on, replication to second region **deferred** (cost; RPO met by versioning).
- App change (Scale-Out Gate only): keep `decodeAndNormalizeImage` untouched; replace sink with
  `PutObject` (`avatars/user{id}-{uuid}.webp`, `Content-Type: image/webp`, SSE-KMS); reads via
  backend auth check → short-lived **presigned GET** (preserves "authenticated reads" contract).
  CloudFront + OAC later (traffic-triggered).
- Migration path (zero-downtime):
  1. Dual-write release (local + S3, read local) → verify object counts match.
  2. Backfill Job (existing volume → S3, checksum compare).
  3. Flip read flag to S3 (presigned) → monitor 404 rate → remove local write in next release.
  4. Compose keeps volume for dev; EKS never mounts uploads.

### 6.3 RPO / RTO (committed, drilled)

| Scenario | RPO | RTO | Mechanism |
|---|---|---|---|
| Accidental data delete / bad migration | ≤ 5 min (PITR) | ≤ 2h | PITR to new instance → repoint ESO → ArgoCD sync |
| AZ failure (prod) | ~0 (Multi-AZ sync) | minutes (auto failover) | RDS Multi-AZ + EKS multi-AZ |
| Region-impacting / full rebuild | ≤ 24h (snapshot) | ≤ 4h | Terraform + GitOps + snapshot restore + S3 versioned objects intact |
| Avatar loss | ~0 | minutes | S3 versioning restore |

---

## 7. Final implementation sequence (gate-approved)

### 7.1 Wave plan (optimized for safety → dependencies → minimal rework → cost)

| Wave | Content | Why this order |
|---|---|---|
| **0. Hygiene + Git** (no behavior change) | Branch protection, CODEOWNERS, PR template, `.gitleaks.toml`, Dependabot, delete dead `socketAuth.js`, archive nothing yet | Gates need a protected `main`; dead secret-fallback removed before any audit |
| **1. Compose baseline** | Resource limits, `init:true`, migration `006` rename (**checksum re-baseline runbook** — runner refuses silently-changed files), local runbook, backup off-host copy (encrypted) | Prod-today hardening; zero infra spend; backup story before touching anything else |
| **2. CI gates** | `ci.yml` (fail-closed) + `security.yml` (scheduled) + required checks | Every later wave is protected from day one; cheapest defect filter |
| **3. Supply chain** | OIDC role, ECR repos, `release.yml` (scan→SBOM→attest→sign→push immutable) | Immutable signed artifacts must exist before any cluster consumes them |
| **4. Terraform + staging data plane** | `terraform/` modules+envs, VPC, ECR, IAM/OIDC, EKS staging, RDS staging, ESO, ALB+ACM+Route53 | Infra scanned by Wave-2 gates; staging DB first so chart has something real |
| **5. Chart + GitOps + staging deploy** | `helm-chess/` (backend ×1 Recreate, validated env), `chess-gitops` repo, ArgoCD (staging auto-sync), Kyverno **audit** | Declarative CD proven on staging with the 1-replica truth intact |
| **6. Observability + alerts** | kube-prometheus-stack, Loki, Alloy, Grafana (SSO), dashboards, SLOs, runbooks, GuardDuty on | You cannot safely attempt scale-out blind; alerts/SLOs baselined on staging traffic |
| **7. SCALE-OUT GATE** (only app-behavior wave) | S3 avatars (dual-write→cutover), Redis (ElastiCache prod / staging small) + adapter + redis limits + userId identity + lazy hydration, ALB stickiness, draining (`preStop`, grace 60s), backend HPA/PDB, RollingUpdate | All prerequisites (staging, GitOps rollback, obs, signed artifacts) in place; validated by 2-replica + pod-kill + split-traffic tests in staging |
| **8. Prod cutover + harden + DR** | Prod EKS/RDS, Kyverno **enforce**, Cosign `verifyImages` enforce, weighted DNS shift, prod checklist sign-off, DR drill, cost dashboard | Enforcement only after staging soak; cutover last, rollback rehearsed |

### 7.2 Dependency graph (phases, must-respect)

```text
Wave0(git) ──► Wave1(compose) ──► Wave2(CI gates) ──┬──► Wave3(ECR/OIDC/release) ──► Wave4(TF+staging EKS/RDS)
                                                    │                                        │
                                                    └──── IaC/K8s scans ────────────────────┘
Wave4 ──► Wave5(chart+gitops+argocd staging) ──► Wave6(observability) ──► Wave7(SCALE-OUT GATE)
                                                                                          │
Wave8(prod cutover) ◄── Kyverno enforce ◄── staging soak evidence ◄── Wave7 green ──────────┘
Legacy archive (Jenkins/Manifest-file/EKS-TF flat) ──► after Wave5 proves replacement (not before)
```

### 7.3 Risks introduced by the migration (new, gate-acknowledged)

1. Migration `006` rename trips checksum guard → mitigated by explicit re-baseline runbook + staging-first.
2. ESO/RDS wiring misconfig breaks staging boot → mitigated by PreSync Job ordering + `readiness` gating sync health.
3. Scale-out regressions (silent rooms, dead rematch) → mitigated by staging 2-replica + chaos tests + instant ArgoCD rollback.
4. Kyverno/`verifyImages` enforce blocks emergency deploys → mitigated by audit-first + documented emergency bypass (break-glass role, alerted).
5. Cost creep (NAT×2, Multi-AZ RDS, EKS) → mitigated by staging-small defaults + cost dashboard + monthly review.

### 7.4 Rollback strategy (per wave)

| Layer | Rollback |
|---|---|
| App (ArgoCD) | Revert digest commit in `chess-gitops` (preferred) or revision rollback; prod < 5 min. Compose prod stays untouched until cutover → instant DNS fallback during Wave 8. |
| Data (RDS) | PITR / snapshot restore to new instance; forward-only migrations (no down path by policy — restore, don't downgrade). |
| Infra (Terraform) | `plan` on revert PR; state-locked; no `destroy` without ticket + snapshot + second approver. |
| Scale-out app changes | Feature flags (`USE_S3_UPLOADS`, `USE_REDIS_ADAPTER`) default OFF; rollback = flag OFF + redeploy prior digest. |

### 7.5 What must be implemented FIRST (Wave 0–2)

Branch protection + CODEOWNERS + gitleaks config; dead-code deletion; compose limits + backup
off-host; `ci.yml` fail-closed gates. Nothing here can break prod; everything later depends on it.

### 7.6 What must NOT be implemented yet (explicitly deferred)

ElastiCache/adapter/HPA/PDB (→Wave 7); OTel SDK sampling (→3rd-hop trigger); RDS Proxy, CloudFront,
cross-region replication (→traffic/cost triggers); Falco, Checkov, SonarQube, Image Updater (rejected,
see §5); Jenkins infra (retired, §3.2); Kyverno/`verifyImages` **enforce** (audit until Wave 8);
prod EKS/RDS before staging soak evidence exists.
