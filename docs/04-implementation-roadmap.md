# Phase 33 — Implementation Roadmap

> **Gate amendment (2026-09-22, authoritative):** phase *contents* below stand; phase *order*
> is superseded by `docs/05-architecture-gate.md` §7 wave plan. Mapping: old Phases 1–2 →
> Waves 0–1 · old 3–7 → Waves 1–2 · old 8–9 → Wave 5 (chart) + Wave 7 (HPA/PDB, backend only
> after gate) · old 10–11 → Wave 4 · old 12 → Wave 4 (narrow scope kept) · old 13–14 → Wave 2 ·
> old 15 → retired (ADR-006) · old 16 → Wave 3 · old 17–18 → Wave 5 · old 19–21 → Wave 6 ·
> old 22 → deferred (trace-ready in Wave 6) · old 23–26 → Waves 6–8.
> Dependency graph, per-wave rollback, first/not-yet lists: gate §7.2–§7.6.

Conventions: every phase lists Objective · Why · Prerequisites · Files · Commands ·
Security · Testing/Validation · Done. Destructive commands are marked ⚠️ with consequences.

Global guardrails: work on `arena/01a0c5c2-end-to-end-kubernetes-chess-de`; small PRs;
never commit `.env`, `certs/`, `backups/`; backend stays 1 replica until the Redis ADR lands.

---

## Phase 0 — Discovery ✅ DONE

Objective: ground-truth inventory. Files: `docs/00-discovery.md`, `docs/01-reverse-engineering-report.md`.
Done when: dependency map + risk register reviewed.

## Phase 1 — Application baseline

Objective: make local prod-like stack reproducible from zero.
Why: everything downstream (CI, images, K8s) copies this contract.
Prerequisites: Docker Engine + Compose v2, openssl.
Files to create: `compose.override.example.yml` (dev), `docs/runbook-local.md`.
Files to modify: `docker-compose.yml` (add `deploy.resources` limits, `init: true`),
  rename `006_add_game_board_fen.sql` → `006b_add_game_board_fen.sql` + re-baseline checksum note.
Commands:

```bash
git status && git checkout -b feat/local-baseline
cp .env.example .env && chmod 600 .env
# edit .env: JWT_SECRET=$(openssl rand -base64 48), DB_PASSWORD=$(openssl rand -base64 32), APP_ORIGIN=https://chess.example.com
docker compose up -d --build
docker compose ps && docker compose logs chess-migration --tail=50
curl --fail http://localhost/liveness || true   # expect 308 via frontend only with host header; prefer:
docker compose exec chess-backend wget -qO- http://127.0.0.1:5000/readiness
docker compose down
```

Security: `.env` 600, never commit; verify no secrets in `docker compose config` output committed.
Testing: migration container exits 0; readiness 200; `npm test` suites green in both apps.
Done when: fresh clone → 5 commands → green readiness, documented in runbook.

Common mistakes: APP_ORIGIN with trailing slash; weak JWT_SECRET; scaling backend to 2.

## Phase 2 — Git/GitHub

Objective: branch strategy + protections + ownership + secret hygiene.
Why: gates are worthless without enforced PR flow.
Prerequisites: repo admin access.
Files to create: `CODEOWNERS`, `.github/pull_request_template.md`, `.gitleaks.toml`,
  `.github/dependabot.yml`, `docs/git-strategy.md` (trunk-based: `main` protected, short-lived
  `feat/*`, squash merge, semantic tags `vX.Y.Z`, changelog via release notes).
Commands (GitHub UI/API — branch protection cannot be set from git):

```bash
gh api repos/{owner}/{repo}/branches/main/protection -X PUT -f required_status_checks[strict]=true \
  -f enforce_admins=true -f required_pull_request_reviews[required_approving_review_count]=1
gh secret list  # audit; remove static AWS/Jenkins keys when OIDC lands
```

Security: enable secret scanning + push protection, Dependabot alerts, least-privilege
`GITHUB_TOKEN` (`permissions: contents: read` per job), signed tags for releases.
Done when: direct push to `main` blocked, CODEOWNERS review required, gitleaks config committed.

## Phase 3 — Linux baseline (single-server prod host)

Objective: hardened Ubuntu 24.04 LTS host runbook.
Why: current prod *is* a Linux host; K8s later doesn't excuse an unhardened foundation.
Files to create: `docs/linux-baseline.md`, `ansible/` roles later (Phase 12).
Commands (on fresh host, as root via console first):

```bash
adduser --disabled-password --gecos '' deploy && usermod -aG sudo,docker deploy
mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
# add admin pubkeys to authorized_keys, chmod 600
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sshd -t && systemctl reload sshd
ufw default deny incoming && ufw default allow outgoing && ufw allow 80,443/tcp && ufw enable
timedatectl set-ntp true
apt update && apt -y upgrade && apt -y install --no-install-recommends docker.io docker-compose-plugin fail2ban unattended-upgrades
systemctl enable --now unattended-upgrades fail2ban
journalctl --disk-usage; grep -r max-size /etc/docker/daemon.json || echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' > /etc/docker/daemon.json
```

Security: SSH keys only, no root, UFW 80/443 only, auto security updates, fail2ban on sshd
(justified: public 22 during bootstrap; close 22 after Tailscale/bastion if available).
Done when: CIS-lite checklist passes, `docker compose up` works as `deploy` without sudo password prompts breaking automation.

## Phase 4 — Nginx (compose edge)

Objective: validate + lightly harden existing `nginx.conf`.
Why: already strong; avoid breaking WASM/CSP/WS while fixing gaps.
Files to modify: `Chess-Frontend/nginx.conf` (add `limit_req` on `/socket.io/` —
  e.g. `zone=api_per_ip burst=80 nodelay` — and `client_body_timeout` already present; verify).
Commands:

```bash
docker compose up -d --build chess-frontend
docker compose exec chess-frontend nginx -t
curl -skI https://localhost/liveness | head -5
nmap -Pn --top-ports 50 chess.example.com   # from outside: only 80/443 open
```

Security: keep TLS 1.2+ (1.3 preferred), HSTS on 443 only, CSP `wasm-unsafe-eval` required for
Stockfish — do NOT remove; test every header change against e2e suite.
Done when: e2e green + headers verified + rate-limit smoke test (429 on flood, 200 normal).

## Phase 5 — Dockerfile hardening

Objective: SBOM-ready, reproducible, minimal images.
Files to modify: all 3 Dockerfiles (add `LABEL org.opencontainers.image.*`, pin base digests,
  add `.dockerignore` coverage check), `Chess-Backend/.dockerignore` + frontend one (verify `coverage/`, `build/`, `.env*` excluded).
Commands:

```bash
docker build -t chess-backend:dev ./Chess-Backend
docker build -t chess-frontend:dev ./Chess-Frontend
docker images --digests | grep chess
syft chess-backend:dev -o spdx-json=sbom-backend.spdx.json
trivy image --severity HIGH,CRITICAL chess-backend:dev
hadolint Chess-Backend/Dockerfile Chess-Frontend/Dockerfile Database/migrations/Dockerfile
```

Security: non-root kept, no secrets in layers (`docker history` audit), digest-pinned bases in CI.
Done when: hadolint clean, Trivy HIGH/CRITICAL = 0 or triaged with expiry, SBOM generated.

## Phase 6 — Docker Compose production-like

Objective: resource limits, restart policies, dev override separation.
Files: `docker-compose.yml` (+`deploy.resources` per service), `compose.dev.yml` (Mailpit + hot reload, never prod).
Commands: `docker compose config --quiet && docker compose up -d && docker compose ps`.
Done when: `docker stats` shows bounded memory; kill -9 backend → auto-restart → readiness green.

## Phase 7 — Container security gates

Objective: enforce non-root, ro-fs, caps-drop, no privileged, scan-on-build.
Commands: same as Phase 5 + `docker inspect` checks scripted in CI (`scripts/check-image.sh`:
assert `User != 0`, `ReadonlyRootfs` via compose, no `Privileged`).
Done when: CI fails a deliberately-privileged test fixture.

## Phase 8 — Kubernetes (Helm chart, backend x1)

Objective: `helm-chess/` chart: Namespace, Deployments (frontend 2 + HPA; backend **1**, Recreate),
  Services (ClusterIP), Ingress (ALB later; nginx-ingress for local kind), ConfigMaps, ESO
  SecretStores, ServiceAccounts (dedicated, `automountServiceAccountToken: false` where unused),
  PDB (frontend only — backend PDB with 1 replica would block drains; document), probes
  (`/liveness`, `/readiness`, startupProbe 60s), requests/limits, topology spread (frontend).
Prerequisites: Phases 5–7 green; kind/k3d for local validation.
Files: `helm-chess/{Chart.yaml,values-{dev,staging,prod}.yaml,templates/*}`.
Commands:

```bash
kind create cluster --name chess && kubectl cluster-info
helm lint helm-chess && helm template helm-chess -f helm-chess/values-dev.yaml | kubeconform -strict
helm upgrade --install chess helm-chess -n chess --create-namespace -f helm-chess/values-dev.yaml
kubectl -n chess get pods,svc,ingress && kubectl -n chess wait --for=condition=ready pod -l app=chess-backend --timeout=180s
kubectl -n chess logs deploy/chess-backend --tail=50
```

⚠️ `helm uninstall`, `kind delete cluster` — destroys local env only; safe locally, never against prod without ticket + backup.
Done when: chart installs on kind, e2e passes against ingress, `helm diff` clean on re-apply.

## Phase 9 — Kubernetes security

Objective: PSS `restricted`, RBAC least-privilege, NetworkPolicies (frontend→backend:5000,
  backend→RDS:5432 + SMTP:587 + DNS TCP/UDP 53), Quota + LimitRange, Kyverno (require
  probes/limits, deny `:latest`/privileged/hostPath).
Files: `helm-chess/templates/{networkpolicy,kyverno-*.yaml}`, `docs/k8s-security.md`.
Commands: `kubectl -n chess apply --dry-run=server -f …; kyverno test ./tests/kyverno` (if adopted).
Done when: violating fixture (privileged pod, missing limits) is rejected with a clear message.

## Phase 10 — AWS architecture

Objective: ADR + account prep (no resources yet): VPC (2 AZ, public/private, 1 NAT/AZ prod,
  1 NAT staging), ALB+ACM+Route53, ECR repos, RDS, S3 avatars, Secrets Manager, KMS, CloudTrail.
Files: `docs/adr/001-aws-topology.md`.
Done when: ADR approved with cost estimate attached.

## Phase 11 — Terraform (`terraform/` modules + envs)

Objective: `modules/{vpc,eks,rds,redis,ecr,iam,acm-dns}/` + `environments/{staging,prod}/`
  with S3 state + DynamoDB lock, tagging, KMS encryption, ESO IRSA roles, RDS Multi-AZ (prod).
Prerequisites: GitHub OIDC provider + deploy role (Phase 14) so no static keys.
Commands:

```bash
terraform -chdir=terraform/environments/staging init -upgrade
terraform -chdir=terraform/environments/staging fmt -recursive -check
terraform -chdir=terraform/environments/staging validate
terraform -chdir=terraform/environments/staging plan -out=tfplan
# apply only from protected workflow after plan artifact review:
terraform -chdir=terraform/environments/staging apply tfplan
trivy config terraform/environments/staging --severity HIGH,CRITICAL
```

⚠️ `terraform destroy` — deletes VPC/EKS/RDS; requires ticket + snapshot verification + second approver.
Done when: staging env builds clean, `terraform-docs` generated, legacy `EKS-TF/` archived (moved to `legacy/`, not deleted silently).

## Phase 12 — Ansible (narrow scope)

Objective: roles `hardening` (single host + bastion), `docker_host`, `ops_agent`.
Responsibility split: Terraform = infra, Ansible = OS/config on EC2/ops hosts only, K8s = workloads.
Done when: `ansible-playbook -i inventory/prod site.yml --check --diff` clean; applied to bastion.

## Phase 13 — CI gates (`ci.yml`)

Objective: one required workflow: gitleaks → lint → unit → integration (PG service) → build →
  hadolint → trivy fs+image (fail on HIGH/CRITICAL) → kubeconform/helm lint → trivy config.
  Least-privilege `permissions`, npm caching, concurrency cancel, artifacts (SBOM, SARIF).
Files: `.github/workflows/ci.yml` (replaces backend-ci/frontend-ci), `security.yml` (scheduled
  CodeQL/Semgrep + npm audit + dependency review).
Done when: red fixture PR (added secret, vulnerable dep, privileged manifest) is blocked with actionable annotations.

## Phase 14 — GitHub Actions → AWS via OIDC

Objective: `iam/github-oidc` Terraform role (`token.actions.githubusercontent.com`, condition
  `repo:{org}/{repo}:*` + env scoping), workflows assume it for ECR push + terraform plan.
Commands: `aws iam get-open-id-connect-provider …`; workflow snippet uses `aws-actions/configure-aws-credentials@v4` with `role-to-assume`, no keys.
Done when: `gh secret list` shows zero `AWS_*` static keys; OIDC assume-role logged in CloudTrail.

## Phase 15 — Jenkins ruling: RETIRE (default)

Objective: archive `Jenkins-Pipeline-Code/` + `Jenkins-Server-TF/` to `legacy/` with a README
  explaining the decision; keep stage list as CI requirements input.
Exception path: if org mandates Jenkins — ephemeral agents on EKS, credentials via ESO,
  no deploy rights (ArgoCD owns deploy). Revisit cost ($200+/mo + maintenance) explicitly.
Done when: no Jenkins infra in plan; docs updated.

## Phase 16 — ECR + supply chain

Objective: repos `chess-backend/frontend/migration` (immutable tags, scan-on-push, lifecycle:
  keep 30 tagged + 5 per PR), `release.yml`: build → SBOM (Syft) → provenance → Cosign keyless
  sign → push `:sha-<7>` + digest; verify admission later via Kyverno `verifyImages`.
Commands: `aws ecr describe-image-scan-findings …; cosign verify …`.
Done when: prod deploy references digest, signature verifies, `:latest` absent.

## Phase 17 — GitOps repo + promotion

Objective: `chess-gitops/{apps,staging,prod}/` (or same-repo `gitops/` to start; split when teams grow):
  image digests per env, Helm values per env, promotion = PR staging→prod.
Done when: staging auto-syncs on release; prod changes only via promotion PR.

## Phase 18 — ArgoCD

Objective: App-of-Apps (`root` → `chess-staging`, `chess-prod`), Projects + RBAC (deployer group),
  auto-sync+self-heal+prune in staging, manual sync prod, sync waves (namespace→secrets→db-job→backend→frontend→ingress).
Commands: `argocd app list; argocd app sync chess-prod --prune`.
Done when: `kubectl` drift corrected automatically in staging; prod rollback = prior Git revision sync < 5 min.

## Phase 19–21 — Prometheus + Grafana + Loki (+Alloy)

Objective: kube-prometheus-stack (internal ClusterIP Grafana behind SSO/OAuth2-proxy, admin
  password from Secrets Manager), Loki + Alloy (single collector: pod logs + OTLP), dashboards:
  app (RPS, p50/p95, 5xx, WS connections, game completions), K8s/nodes, RDS (Enhanced Monitoring),
  ingress/ALB.
Done when: RED dashboards live for staging; log→metric correlation (`trace_id` later) works from one Grafana.

## Phase 22 — OpenTelemetry: TRACE-READY, SAMPLER DEFERRED

Objective: propagate `traceparent` through Nginx→backend, structured JSON logs with `request_id`;
  full SDK sampling only after Redis/worker phase adds a third hop.
Done when: each request has correlated access+app log lines.

## Phase 23 — Alerting & SRE

Objective: SLOs (99.5% avail, p95 < 400ms, 5xx < 0.5%) + burn-rate alerts, crashloop, PDB-blocked,
  PVC 80%, RDS failover/connections, ACM expiry 21d, ArgoCD sync fail, ECR scan CRITICAL.
  Runbooks linked per alert; weekly alert review; incident template (SLI→SLO→alert→incident→RCA).
Done when: chaos drill (kill backend pod, expire staging cert) pages correctly and runbook resolves.

## Phase 24 — Production hardening checklist

Objective: execute `docs/prod-checklist.md`: ports, IAM, SGs, TLS, secrets rotation drill,
  RBAC, NetworkPolicy deny-all default + allows, backups, monitoring, limits, HPA(frontend),
  deployment strategy (RollingUpdate frontend; Recreate backend), rollback drill.
Done when: checklist signed + evidence (command outputs) attached to release ticket.

## Phase 25 — DR drill

Objective: destroy staging → rebuild from Terraform + GitOps + restore RDS snapshot + S3 →
  validate e2e; measure RPO/RTO; promote learnings to prod runbook.
⚠️ Never drill against prod without maintenance window + snapshot < 1h old.
Done when: staging rebuilt < 2h with passing e2e, timings recorded.

## Phase 26 — Production cutover

Objective: DNS weighted shift Compose→ALB/EKS (or big-bang with rollback snapshot for small
  traffic), freeze non-security changes 48h, hypercare rotation, cost dashboard live.
Done when: SLOs green 7 days, rollback path tested, handover runbook accepted by on-call.
