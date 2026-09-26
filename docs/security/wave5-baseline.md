# Wave 5 security baseline — secure staging Kubernetes delivery (GitOps)

Status: IMPLEMENTED + LOCALLY VALIDATED. Live AWS/EKS/ArgoCD proof is
USER-SIDE (this sandbox has no cluster, no Helm binary, no AWS credentials).
Nothing below is claimed from an unexecuted run.

Wave 5 delivers staging ONLY: `GitHub -> CI -> ECR digest -> chess-gitops
(SEPARATE repo) -> ArgoCD -> EKS staging -> RDS`. No production deploy, no
Wave 6 observability, no Wave 7 scale-out. Backend stays exactly 1 replica.

## A. Delivery chain (authoritative)

```text
main merge -> ci (tests/scans) -> release (build/scan/SBOM/push/sign/index)
  -> gitops-commit-back (digests -> chess-gitops/apps/chess/staging/images.yaml)
    -> ArgoCD app chess-staging (chart from APP repo + values from GITOPS repo)
      -> PreSync: SecretStore/ExternalSecrets (wave -2)
      -> PreSync: migration Job (wave -1, advisory-locked, master creds)
      -> Sync: backend:1 (Recreate) + frontend:2 (Rolling) + ClusterIPs +
         PVC/RWO + ALB Ingress + NetworkPolicy + PDB
```

Authorities: chart `deploy/helm/chess/` (THIS repo), environment identity
(`chess-gitops` repo), images (Wave 3 ECR digests), secrets (Wave 4
Secrets Manager via ESO). CI deploys NOTHING (commit-back writes digests
only); Jenkins/legacy manifests never deploy (LEGACY-marked).

## B. Chart contract (`deploy/helm/chess`, 21 files)

- `Chart.yaml`: v2, `kubeVersion >= 1.30.0`, appVersion tracks images by digest.
- `values.yaml`: fail-closed defaults — digests/hosts/ARNs/CIDRs all `""`;
  `chess.image` helper `fail()`s on empty registry or non-`sha256:<64hex>`;
  `ingress.certificateArn` + `database.host` are `required()`.
- `values-staging.yaml`: portable staging knobs ONLY (namespace `chess-staging`,
  service names, timeouts, ESO store names, PDB). Zero identity.
- Guards: `backendReplicaGuard` fails the render unless backend replicas == 1
  (there is deliberately NO `backend.replicaCount` value — no knob exists).

## C. Workload contracts

| Workload | Replicas/strategy | Probes (real endpoints) | Resources req/lim | Grace |
|---|---|---|---|---|
| backend | 1, Recreate (RWO deadlock-proof) | live `/liveness` (no deps), ready `/readiness` (startup+007 row) | 250m/384Mi, 1cpu/768Mi | 30s |
| frontend | 2 + PDB minAvailable 1, RollingUpdate | live+ready `/` (nginx static; never proxied backend paths) | 100m/128Mi, 500m/256Mi | 15s |
| migration | one-shot Job, PreSync wave -1 | n/a (advisory lock 724337771, activeDeadline 600s, backoff 3) | 100m/128Mi, 500m/256Mi | 30s |

Sources: compose sizing doubled for JVM/Node headroom where measured
(frontend 256m/128m compose -> 100m/128Mi req + 500m/256Mi lim); grace =
compose stop_grace_period + SIGTERM handler reality (30s backend, 15s nginx).
All pods: non-root UID/GID (1001 backend/migration, 101 nginx), fsGroup,
RuntimeDefault seccomp (pod AND container level), `drop: [ALL]`,
`allowPrivilegeEscalation: false`, readOnlyRootFilesystem + explicit emptyDirs
(backend `/tmp` 64Mi + `uploads` PVC; frontend 3 tmpfs; migration `/tmp` 16Mi),
dedicated SAs with `automountServiceAccountToken: false`.

nginx overlay (`configmap-frontend-nginx.yaml`): baked behavior preserved
(upstream `chess-backend:5000`, `/api|/uploads|/socket.io` proxy incl. Upgrade
headers, `/liveness|/readiness` pass-throughs, rate limits incl. auth zones,
security headers + HSTS, SPA fallback); ONLY compose-TLS artifacts dropped
(8443/ssl_certificate/return 308/ACME) — static-checked for parity both ways.

## D. Data layer (RDS, `force_ssl`)

- Backend pool: `DB_HOST` (required fail-closed) + `DB_SSL_CA` from `chess-app`
  secret (PEM file via subPath; `rejectUnauthorized: true` documented).
- Grants: `008_app_grants.sql` (USAGE + tables + sequences + functions +
  default-privs to `chess_user`, fail-closed `\set ON_ERROR_STOP`, NO `FOR
  ROLE` so compose/integration runners keep working). 001–007 byte-frozen
  (static check diffs each against HEAD).
- Migration Job runs `node run.js` (frozen filenames) with MASTER creds from
  `chess-db-master`; backend NEVER migrates and NEVER mounts master creds
  (static-checked). Forward-only: no down migrations exist; rollback = app
  revert + forward fix (see M).

## E. Secrets (ESO + IRSA, least privilege)

- `SecretStore chess-secret-store` (region us-east-1, no auth block — the ESO
  controller's IRSA role is the credential). 2 `ExternalSecrets`, 5m refresh,
  deletionPolicy Retain: `chess-db-master` (RDS-managed secret ARN, owner
  output) + `chess-app` (`chess/staging/app`, owner-created JSON).
- IRSA: ESO controller role from the Wave 4 factory (`eso` namespaced role):
  `secretsmanager:Get/Describe` on exactly 2 ARNs. Pod SAs (`chess-backend`,
  `chess-migration`, none for frontend beyond its SA) carry NO AWS identity.
- No plaintext Secret anywhere (static-checked); trust chain: app repo -> ESO
  -> Secrets Manager; rotation = update secret, ESO re-syncs in <= 5m.

## F. Network (ALB-only ingress, deny-by-default)

- Ingress `internet-facing`, `target-type: ip`, ACM TLS + `ssl-redirect`,
  healthcheck `/`, single rule host->frontend:80. Backend has NO route.
- `NetworkPolicy`: default-deny ingress + allow ALB (VPC CIDR, documented) to
  frontend:8080; node CIDRs to 8080/5000 (kubelet probes; SMTP alert if
  widened); frontend pods -> backend:5000 (podSelector, least privilege);
  egress restricted DNS + HTTPS + DB (53/443/5432); migration NONE (complete
  egress exception, documented + user-side validated).
- Same-origin: `FRONTEND_URL == https://<ingress host>` enforced by backend
  (`isConfiguredOrigin`); cookies stay `Secure + HttpOnly + SameSite=Lax`.

## G. GitOps bundle (`chess-gitops`, SEPARATE repo, 16 YAML + bootstrap)

Map: `projects/` (chess-staging + platform AppProjects) / `apps/chess/staging/`
(Application + `images.yaml` COMMIT-BACK TARGET + `wiring.yaml` owner-filled)
/
`apps/platform/{eso,kyverno,policies}/` / `bootstrap/` (pinned ArgoCD install
v3.5.3 + RBAC ConfigMap). 16 files, all YAML-parsed by the static battery.

- AppProjects: no wildcards; chess destination = in-cluster `chess-staging`
  ONLY; namespaced kinds whitelisted to exactly the 11 the chart renders;
  cluster kinds = Namespace + StorageClass only.
- Application: multi-source (chart @ app repo `main`, values @ gitops `main`
  ref `values`), precedence values < staging < images < wiring, automated
  prune + selfHeal, `CreateNamespace + foreground prune + ApplyOutOfSyncOnly`.
- ArgoCD hardening: ClusterIP-only (port-forward access), pinned manifest,
  RBAC ConfigMap ADDS a read-only role (default admin untouched — no lockout
  risk), initial password rotated user-side (runbook L).
- Sync-order contract: ESO -> Kyverno/policies -> chess PreSync secrets ->
  PreSync migration -> workloads. `chess_user` + app secret MUST exist first
  (L.3); 008 fails closed otherwise (visible, safe).

## H. Commit-back (release -> gitops)

`release/gitops-commit-back.py` (stdlib, line-preserving): validates 3 digests
(`^sha256:[0-9a-f]{64}$`) + single registry from `release-index.json`, rewrites
exactly 4 lines, fails closed on schema drift or weak digests (fixture-tested,
incl. `latest` rejection). Job `gitops-commit-back` in `release.yml`:
`contents:read`, pushes via fine-grained PAT (`vars.GITOPS_REPO` +
`secrets.GITOPS_REPO_TOKEN`, contents:write on the gitops repo ONLY), SKIPS
with notice until configured, then fails real (no `continue-on-error`).

## I. Kyverno (AUDIT-only, 5 policies)

`disallow-privileged / require-run-as-non-root / require-seccomp-runtimedefault
/ require-resources / require-image-digest` — all `validationFailureAction:
Audit`, `background: true`, platform namespaces excluded. Chart pods comply at
container level already (explicit runAsNonRoot + seccompProfile); reports prove
it before Wave 8 enforcement. No Image Updater (digests come from commit-back).

## J. Sizing + single-replica rationale

Backend = 1 is ARCHITECTURE (process-local Socket.io rooms + rate limiters +
local uploads), not a default: hardcoded + render-guarded + static-checked,
with the Wave 7 path (Redis adapter/rate-limit, S3 uploads, HPA, PDB>1)
documented in the chart README. Frontend = 2 + PDB (stateless, AZ-spread).
Sizing is staging-realistic from compose measurements; PROD sizing waits for
observed staging data (Wave 6 metrics feed Wave 7 HPA).

## K. Placeholder inventory (no other CHANGEMEs exist — static-checked)

Gitops repo: `CHANGEME_GITOPS_REPO_URL` (6 files), `CHANGEME_ECR_REGISTRY`,
`CHANGEME_{BACKEND,FRONTEND,MIGRATION}_DIGEST` (commit-back fills),
`CHANGEME_RDS_ENDPOINT / _STAGING_ORIGIN / _STAGING_HOST / _ACM_ARN /
_VPC_CIDR / _APP_SUBNET_{A,B}_CIDR / _RDS_MASTER_SECRET_ARN / _ESO_ROLE_ARN`
(owner fills, §L). Every one maps to a Terraform output or an owner AWS
action — zero invented identity.

## L. Owner runbook (first staging deploy, USER-SIDE)

```bash
# L.0 outputs (from terraform/environments/staging)
terraform -chdir=terraform/environments/staging output rds_endpoint
terraform -chdir=terraform/environments/staging output rds_master_user_secret_arn
terraform -chdir=terraform/environments/staging output eso_role_arn
# L.1 create gitops repo + push bundle (exact URL -> CHANGEME_GITOPS_REPO_URL)
gh repo create <OWNER>/chess-gitops --private --description "GitOps state for chess staging"
cd /home/user/chess-gitops && git remote add origin git@github.com:<OWNER>/chess-gitops.git
# L.2 fill wiring.yaml + eso values (K table), commit, push
# L.3 pre-create app secret JSON + chess_user role (BEFORE first sync):
#   chess/staging/app = {"DB_USER":"chess_user","DB_PASSWORD":"<gen>",
#     "JWT_SECRET":"<gen>","FRONTEND_URL":"https://<host>",
#     "SMTP_HOST":...,"SMTP_PASSWORD":...,"EMAIL_FROM":...,"DB_SSL_CA":"<rds-ca-pem>"}
#   psql "$RDS_URL" -c "CREATE ROLE chess_user LOGIN PASSWORD '<same>';"
# L.4 ./bootstrap/install-argocd.sh ; rotate admin password
#     (kubectl -n argocd port-forward svc/argocd-server 8080:443)
# L.5 watch syncs: eso -> kyverno -> policies -> chess-staging
#     (PreSync secrets, then migration, then workloads Healthy)
# L.6 verify (acceptance): https://<host> loads, login works, move syncs
#     across a second browser (Socket.io), PolicyReports show 5x PASS
```

## M. Rollback

- APP (bad release): `git revert` the digest commit in `chess-gitops`;
  ArgoCD re-syncs previous digests (backend Recreate restarts once). No
  image rebuild, no CI wait.
- INFRA (bad chart/TF): revert the chart commit (ArgoCD syncs back) or
  `terraform plan/apply` the previous TF revision (staging only, owner).
- DB (bad migration): FORWARD-ONLY — new migration fixing forward; never
  `down`, never manual DDL on RDS. Migration Job history (`kubectl -n
  chess-staging get jobs`) shows exactly what ran.
- SECRET rotation without deploy: update Secrets Manager; ESO refreshes
  <= 5m; restart pods (`kubectl rollout restart`) to pick up env.

## N. Threat matrix (26 rows)

| # | Threat | Control (Wave 5) | Validation | Residual | Rollback |
|---|---|---|---|---|---|
| 1 | Mutable/attacker tag deployed | digest-only `chess.image` + fail-closed | static + helm fail test (CI) | digest typo in commit-back | revert digest commit |
| 2 | Unsigned image runs | Wave 3 cosign sign+attest; Kyverno digest audit | verify cmds (Wave 3 README) | verifyImages not enforcing yet | digest revert |
| 3 | Backend scaled out (state split) | hardcoded 1 + render guard + CI grep | static checks | none (3 layers) | n/a |
| 4 | Migration runs twice / races | PG advisory lock + PreSync + backoff | Job history | lock-holder crash mid-DDL | forward fix |
| 5 | Migration against wrong DB | master secret via ESO, host required() | ESO + render fail tests | wiring typo | fix wiring, re-sync |
| 6 | App creds gain DDL/superuser | 008 grants least-priv (no SUPERUSER/CREATEDB) | 008 review + static | overly-wide future grant | forward grant-fix |
| 7 | Secret in git | ESO-only; plaintext grep in CI | static + §R greps | owner pastes secret in wiring | rotate + purge history |
| 8 | Over-broad IRSA | ESO role: 2 ARNs, Get/Describe only | TF static + plan review | controller compromise scope | detach policy |
| 9 | Pod breakout (priv/host) | drop ALL + non-root + seccomp + no host*/priv | static + Kyverno audit | kernel 0-day | node recycle (Wave 8) |
| 10 | Writable rootfs abused | readOnlyRootFS + minimal emptyDirs | static + Kyverno | /tmp abuse within limits | restart pod |
| 11 | Backend exposed publicly | ClusterIP + ingress frontend-only + netpol | static + live curl (L.6) | ALB mis-target | fix ingress, re-sync |
| 12 | Cross-namespace lateral move | default-deny + podSelector-only app paths | netpol review + live test | DNS-tunnel (audited) | tighten policy |
| 13 | kubelet probes blocked | node-CIDR allowance (explicit, narrow) | L.6 readiness green | CIDR drift | update wiring |
| 14 | Cookie theft (XSS/subdomain) | HttpOnly+Secure+Lax, single https origin | code review (Wave 1) | XSS payload itself | rotate JWT secret |
| 15 | CORS allow-all regression | explicit origins + fail-closed | server.js review | env typo | fix secret, restart |
| 16 | Socket.io cross-origin hijack | origins match CORS list | client+server review | — | same as 15 |
| 17 | TLS downgrade / plain HTTP | ACM + ssl-redirect + HSTS | L.6 curl -I check | ACM expiry (alert Wave 6) | re-issue cert |
| 18 | ArgoCD publicly exposed | ClusterIP-only + port-forward | bootstrap review | — | n/a |
| 19 | ArgoCD admin lockout/weak RBAC | RBAC adds role only; rotation in runbook | bootstrap review | initial-pw window | rotate immediately |
| 20 | GitOps repo push by attacker | fine-grained PAT, gitops-only, no admin | release.yml review | PAT leak (blast = staging digests) | revoke PAT, revert |
| 21 | Chart renders without identity | required()/fail() on all identity values | helm fail tests (CI) | — | n/a |
| 22 | PVC data loss on prune | Retain-class Delete only via git removal (reviewed) + Recreate backend | chart review | accidental storage removal | restore from RDS (uploads are cache+DB? NO — uploads on PVC!) |
| 23 | Upload loss (PVC is single copy) | documented; Wave 7 moves to S3 | — | REAL: AZ/node loss loses uploads | restore from backup (Wave 6 backups prereq) |
| 24 | 007-gate wedges readiness | migration-before-workload ordering | sync-order review | dirty 007 row | forward migration |
| 25 | ESO outage = stale secrets | 5m refresh + Retain + hook ordering | ESO app health | ESO down > secret TTL | restart ESO; secrets persist (Retain) |
| 26 | Supply-chain chart swap | pinned ESO 2.11.0 / Kyverno 3.9.1 / ArgoCD v3.5.3 (SHA-pinned actions) | static version asserts | upstream compromise | pin to prior digest |

Row 22/23 honesty note: staging uploads live on a single RWO PVC (matches
current local-uploads architecture); durability is explicitly a Wave 6
(backup) + Wave 7 (S3) item, NOT claimed solved here.

## O. Validation ledger

VALIDATED (this sandbox): wave5 static battery (chart+release+bundle, ALL
PASS); commit-back fixture incl. weak-digest rejection; release.yml +
infra-validation.yml YAML-parse + job wiring; bundle YAML-parse (16 files);
bash -n bootstrap; migrations frozen (git diff); backend/frontend unit tests
per Wave 1 commands (see below); `tsc`? n/a (JS). NOT RUN — ENVIRONMENT
LIMITATION: `helm lint/template` + kubeconform (release-asset downloads are
SSL-blocked in this sandbox; Helm 4 ships binaries via get.helm.sh, not
GitHub assets — verified v4.3.0 is the latest stable tag, so CI's
setup-helm pin is correct) — covered by blocking CI job `helm-validate`
(USER-SIDE VALIDATION REQUIRED: first green run on main); EKS/ArgoCD live
sync (USER-SIDE per §L); `terraform plan` on Wave 5 TF (no credentials —
USER-SIDE: plan must show addons + ESO role only); `docker build` (no daemon
— USER-SIDE: first release run builds all 3 images).

## P. Wave 6 + 7 prerequisites (hand-off)

- Wave 6 (observability): needs NOTHING new from Wave 5 — ServiceMonitors
  attach to `chess-backend:5000/metrics`? NO (no /metrics endpoint exists —
  Wave 6 must ADD one or scrape logs); ALB access logs + RDS enhanced
  monitoring are owner-side; SLOs need the L.6 acceptance baseline FIRST.
- Wave 7 (scale-out): unblockers are CODE changes (Redis Socket.io adapter +
  shared rate-limit + S3 uploads), THEN chart changes (HPA, backend PDB,
  `backend.replicaCount` knob replacing the guard). The guard's error message
  points here. No Wave 7 work started.

## Q. Legacy inventory (kept, LEGACY-marked, never deployed)

`Manifest-file/` (NEW marker this wave), `EKS-TF/`, `Jenkins-Server-TF/`,
`Jenkins-Pipeline-Code/` (Wave 4 markers), `monitoring/` (compose-era;
superseded by Wave 6 — marker then). CI never applies any of them: the only
deploy path is ArgoCD-from-gitops; `infra-validation` scans legacy TF
report-only.

## R. §26 security greps (run 2026-09-22, justified per hit)

Terminal evidence (2026-09-22, zero unexplained hits): `privileged: true`,
`runAsUser: 0`, `hostNetwork|hostPID|hostPath`, `type: LoadBalancer`,
`HorizontalPodAutoscaler`, `stringData` — ZERO in deploy/ + bundle;
`NodePort` — 1 hit, YAML comment prose ("No NodePort", backend-service);
`ClusterRole|ClusterRoleBinding` — 1 file, AppProject whitelist STRINGS
(platform.yaml:25/27 — permission bounds, not grants); `redis` (case-insens)
— 2 hits, both Wave-7-path prose (deployment comment + chart README);
image `:latest|:main|:dev`, `s3://|S3_BUCKET`, `AKIA|BEGIN PRIVATE|password:|
ghp_|xox` in bundle, `"*"` in projects, `GITHUB_TOKEN` in commit-back — ALL
ZERO (commit-back pushes with the scoped PAT only).

## S. Residual risks (accepted for staging)

1. Upload durability (N.22/23) — accepted; backup+S3 in Waves 6/7.
2. Kyverno audit-not-enforce — accepted; enforcement is Wave 8.
3. No live-sync proof yet — accepted; §L is the explicit user-side gate.
4. Single AZ-dependence of RWO PVC — accepted for staging; prod uses S3.
5. `chess/staging/app` created by hand (L.3) — accepted; documented, rotation
   path exists, Terraform-management is a Wave 8 hardening item.
