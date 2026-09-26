# Wave 4 Security Baseline — AWS infrastructure foundation (Terraform)

Date: 2026-09-22 · Scope: `terraform/` (networking/eks/rds/iam modules,
staging + production roots, bootstrap) + CI flip · App behavior: **unchanged**
Gate: `docs/05-architecture-gate.md` · Prior: `docs/security/wave3-baseline.md`

## 1. Legacy infrastructure audit (all NON-AUTHORITATIVE, kept + marked LEGACY)

| Area | Finding | Verdict |
|---|---|---|
| `EKS-TF/vpc.tf` | 2 PUBLIC subnets only; nodes get public IPs; single shared SG `Jenkins-sg` | dangerous — NOT reproduced |
| `EKS-TF/eks-cluster.tf` | API `endpoint_public_access=true` unrestricted; logging on (7d) is the one good idea | endpoint pattern rejected; logging idea reused (30d) |
| `EKS-TF/eks-node-group.tf` | AL2023 + t3.medium + managed group are sound; `ignore_changes desired` reused | reusable ideas only |
| `EKS-TF/iam-*.tf` | standard managed policies OK; no OIDC/IRSA at all | IRSA gap closed by Wave 4 |
| `EKS-TF/backend.tf` | S3 + `dynamodb_table` locking | obsolete pattern (deprecated since TF 1.11) — native `use_lockfile` used |
| `EKS-TF` version | EKS 1.33 default | stale: past standard support Sept 2026 → Wave 4 defaults 1.35, floor 1.34 |
| `Jenkins-Server-TF/vpc.tf` | single public subnet; SSH/8080/9000 open to `0.0.0.0/0` | dangerous — NOT reproduced |
| `Jenkins-Server-TF/iam-policy.tf` | claims "minimal" but grants `Resource:"*"` EKS/ECR/EC2-write/IAM-write incl. SG mutation + `CreateSubnet` | overprivileged — deployer policy rewritten from scratch, still best-effort (§7) |
| `Jenkins-Server-TF/ec2.tf` | IMDSv2 enforced, EBS encrypted — good ideas | reusable ideas (no EC2 in Wave 4) |
| `Manifest-file/` | backend/frontend `replicas: 2` + HPA, postgres in-cluster, `YOUR_DOCKERHUB_USERNAME` placeholders | stale + contradicts backend×1 constraint — Wave 5 replaces |
| State/region | `us-east-1`, S3 backend, `~> 5.0` provider — sound choices | reused (region, S3 backend, provider line) |
| Missing everywhere | private subnets, NAT, RDS, OIDC, KMS, flow logs, deletion protection | all built in Wave 4 |

Nothing was copied blindly: every legacy file was read; reusable fragments are
re-derived in the new modules with comments, dangerous patterns are listed
above so reviewers can confirm their absence.

## 2. Architecture (as built)

```text
terraform/bootstrap      one-time: state bucket (+log bucket), TLS-only, versioned, prevent_destroy
terraform/modules/networking   VPC 10.20/16 (stg) — public/app/data subnets, IGW, NAT, S3 endpoint, flow logs
terraform/modules/eks          private cluster 1.35 + managed nodes + KMS secrets + logs + OIDC + access entries + 3 add-ons
terraform/modules/rds          postgres 16, data subnets, TLS enforced, RDS-managed master secret, deletion-protected
terraform/modules/iam          IRSA factory, EMPTY in Wave 4 (trust anchor ready, zero workload perms)
terraform/environments/staging    2 AZ, 1 NAT, single-AZ RDS, 7d backups — the Wave 4 target
terraform/environments/production 3 AZ, per-AZ NAT, Multi-AZ RDS, 30d backups — PLANNED, DO NOT APPLY
```

## 3. Decisions with security impact (deviations from the brief are explicit)

1. **No custom node/control-plane SGs** (§7): EKS-managed cluster SG is the
   sole RDS ingress source. Hand-rolled node↔API rules break clusters subtly;
   pod segmentation moves to NetworkPolicy (Wave 7/8), not SG surgery.
2. **`deletion_protection = true` hardcoded incl. staging** (§11/§14):
   destroying a database is always a deliberate code change + apply, never an
   accident. Staging keeps `skip_final_snapshot = true` (disposable data).
3. **Deployer = owner/admin + MFA for bootstrap** (§4): the shipped
   `deployer-policy.json` is best-effort/unvalidated (no AWS to test against);
   it is an artifact for user-side hardening, not a proven gate. CI applies:
   none in Wave 4 (Wave 5 OIDC deploy role).
4. **No CloudTrail resource** (§16): account-level, would duplicate. Runbook
   verifies existence instead.
5. **No CMK on CloudWatch log groups**: AWS-managed SSE accepted for staging;
   CMK-wrapping log groups needs logs-service key grants — revisit with
   compliance need (same bar as the checkov ADR).
6. **Checkov NOT added** (§20, gate ADR): `terraform validate` + Trivy config
   (blocking in CI) + hand static checks are the control set. tflint stays
   gate-approved-but-uninstalled: it needs network I don't have, and an
   untested linter config risks red-noise on first push. Revisit in Wave 5
   with a runnable toolchain.
7. **EKS add-ons `most_recent = true`** instead of pinned builds: EKS build
   suffixes rot fast and a wrong pin fails apply; drift is reviewed via plan
   diff. (Supply-chain note: add-ons resolve from AWS's signed registry, not
   arbitrary HTTP — residual risk accepted, §9 row 14.)

## 4. Networking record

- Staging `10.20.0.0/16`: public `10.20.0/16.0/20`, app `10.20.48/64.0/20`,
  data `10.20.96/112.0/20` (verified non-overlapping by
  `scripts/terraform-static-checks.py`, see §10). Production `10.30.0.0/16`
  mirrors the math. Legacy `10.0.0.0/16` untouched.
- Data subnets have NO default route (local only). App subnets egress via NAT;
  no public IPs, no IGW route → inbound Internet impossible.
- `0.0.0.0/0` occurrences in Wave 4 code (all justified):
  - 2× route-table default routes (public→IGW, app→NAT) — required egress,
    commented in code;
  - 2× `!contains(..., "0.0.0.0/0")` VALIDATIONS that *refuse* open CIDRs;
  - 2× runbook greps + example IP `203.0.113.10/32` (TEST-NET-3, not routable);
  - `Principal "*"` + `Action "s3:*"` in ONE Deny-with-TLS-condition bucket
    statement (standard pattern; Deny, not Allow).
- `5432`: RDS SG rule (source = EKS SG only) + instance `port` + docs. No
  `0.0.0.0/0 → 5432` anywhere.
- `AdministratorAccess`: zero occurrences in `terraform/` (one mention in
  legacy audit prose, §1 of the infra README history — not a grant).

## 5. Security-group / traffic matrix (§17)

| # | Source → Destination | Port/Proto | Mechanism | Reason |
|---|---|---|---|---|
| 1 | Internet → public subnets | — (no SG) | no workloads, no SGs attached | nothing to attack; NAT/LB only |
| 2 | App subnets → Internet | TCP 443/80 egress | NAT route (no IGW route inbound) | ECR/API pulls, patches; inbound impossible |
| 3 | EKS nodes/pods → RDS | TCP 5432 | `chess-stg-rds` ingress, source = EKS cluster SG | application data path (Wave 5) |
| 4 | EKS nodes ↔ control plane | 443/10250 etc. | EKS-managed SG (AWS-owned rules) | cluster operation; not hand-editable, documented |
| 5 | App/data subnets → S3 | HTTPS | gateway endpoint route | ECR layers off NAT (free, private) |
| 6 | Owner → EKS API (optional) | TCP 443 | `public_access_cidrs` (default NONE) | kubectl without VPN; explicit CIDRs only |
| 7 | (Wave 5) Internet → ALB → nodes | 443 → NodePort | NOT BUILT | no LB exists; row reserved |
| 8 | RDS → anywhere | — | NO egress rule (default pruned) | database initiates nothing |

Lateral: node↔node within the EKS-managed SG is AWS-default-open (CNI/DNS
requirement); pod-level segmentation is a Wave 7/8 NetworkPolicy item.

## 6. IAM summary

- Cluster role: `eks.amazonaws.com` + `AmazonEKSClusterPolicy` only.
- Node role: `ec2.amazonaws.com` + WorkerNode/CNI/ECR-ReadOnly only. No
  CloudWatch agent policy (legacy had it; Wave 6 decides), no app permissions.
- Admin: API-mode access entry (`AmazonEKSClusterAdminPolicy`, cluster scope)
  for the owner ARN + bootstrap-creator admin (creator IS the owner in Wave 4).
- IRSA: OIDC provider + empty factory. No `AdministratorAccess`, no workload
  policies, no instance profiles (managed groups don't need them).
- Flow-logs role: `vpc-flow-logs.amazonaws.com`, write-only to its own log group.
- KMS keys (eks-secrets, rds): root-delegation policies, rotation ON,
  30-day deletion window, aliases; `Resource "*"` inside key policies is
  AWS-mandated (scope = key attachment), noted for the §29 grep.

## 7. Database security

- Master password: generated/stored/rotated by RDS in Secrets Manager under
  OUR KMS key. It appears NOWHERE: not in `.tf` files, not in tfvars examples
  (`CHANGEME` placeholders only), not in outputs (ARN only), not in state
  except the ARN. `git grep -i password terraform/` hits: attribute NAMES only.
- `chess_admin` (master) ≠ `chess_user` (app): the least-privilege app user is
  created by a Wave 5 migration job, never by Terraform.
- In transit: `rds.force_ssl = 1` (custom param group, the one justified
  override) + IAM DB auth enabled (second auth path, unused until Wave 6+).
- At rest: gp3 encrypted with dedicated, rotating CMK; PI encrypted with same.
- Backups: automated, 7d staging / 30d prod, windows set, tags copied,
  PITR-capable (`LatestRestorableTime` verified in runbook step 11).
- Restore drill + destroy guard documented in `terraform/README.md` (no
  cross-region DR until Wave 8 — foundation only: retention + snapshots + PITR).

## 8. State security

- S3 + native lockfile, encrypted, versioned (90d noncurrent pruning),
  BucketOwnerEnforced, all-public-blocked, TLS-only Deny policy, access-logged
  to a dedicated hardened bucket, `prevent_destroy` on both buckets.
- `.gitignore`: `*.tfstate*`, `.terraform/`, `*.tfplan`, `terraform.tfvars`,
  `terraform/**/backend.local.hcl` (added Wave 4), crash logs.
- Backend bucket name: injected via `-backend-config`, never committed.
- Bootstrap local state: runbook deletes it post-apply (references buckets only).

## 9. DevSecOps threat / control / residual-risk matrix (§23 + every-wave reminder)

| # | Threat | Attack surface | Control | Validation | Residual risk | Rollback |
|---|---|---|---|---|---|---|
| 1 | Exposed AWS mgmt plane (console/API creds) | owner keys, TF runs | admin+MFA documented; no creds in repo/CI; scoped deployer policy artifact | secret grep; gitignore audit | key theft on owner machine — out of repo scope; rotate + CloudTrail review | rotate creds; no infra change |
| 2 | Public EKS API abuse | `endpoint_public_access` | default OFF; explicit-CIDR validation refuses `0.0.0.0/0` | validation blocks + plan review | owner adds wide CIDR anyway — their explicit act, visible in tfvars/plan | set `[]`, apply |
| 3 | Public worker nodes | subnets | nodes in private app subnets, no public IP, no IGW route | subnet attribute assertions (§10) | — | re-create node group |
| 4 | Public RDS | instance + SG | `publicly_accessible=false`, data subnets (no default route), SG source = EKS SG | assertions; runbook verify | — | SG rule removal = one apply |
| 5 | Broad security groups | SG rules | exactly ONE ingress rule in Wave 4 code (5432 from EKS SG); zero egress | rule-count assertion (§10) | EKS-managed node↔node open (AWS default; NetPol later) | rule resource delete |
| 6 | Overprivileged IAM (cluster/node) | role policies | AWS-managed min-set; no app perms on nodes; admin = owner only | attachment list review | managed-policy scope creep by AWS — plan diff catches | detach + apply |
| 7 | Stolen Terraform credentials | owner workstation/CI | Wave 4: no CI creds at all; local state git-ignored; lockfile prevents concurrent apply | no CI apply job exists | workstation compromise — owner hygiene + MFA | state lock expiry; plan review |
| 8 | Compromised GitHub workflow | CI jobs | CI runs fmt/validate/scan only (no creds, no apply, `contents:read`) | workflow perms audit | — | revert workflow |
| 9 | State-file leakage | S3 bucket | encryption, versioning, no public, TLS-only, logs, prevent_destroy | config review; runbook | bucket-policy mis-edit by owner — versioning + MFA-delete (future) | version restore |
| 10 | KMS misuse (decrypt/grant) | 2 CMKs | root-delegation (account boundary), rotation on, no app grants in Wave 4 | policy review | owner-account-wide access by design — scoped key policies in Wave 8 if compliance needs | key disable (break-glass) |
| 11 | DB credential leakage | secret, outputs, logs | RDS-managed secret; ARN-only output; no password anywhere in repo | password grep (§10) | DBA reads secret via console — legitimate path, CloudTrail-logged | RDS rotation |
| 12 | Lateral movement (pod→data) | network | data subnets isolated; only 5432 from cluster SG; no pod→Internet except NAT egress | matrix §5 | compromised pod reaches RDS port — needs DB creds too (defense in depth) | NetPol (Wave 7/8) |
| 13 | Compromised workload identity | IRSA | ZERO IRSA roles exist; factory validates `Action "*"` refusal | empty-map assertion | — | role delete |
| 14 | Insecure TF module / add-on drift | registry, most_recent | provider pins `~> 5.0`/`~> 4.0`; add-ons from AWS signed registry; plan-diff review | pin grep; CI validate | malicious provider release in 5.x — lockfile review on first init (owner) | pin exact version |
| 15 | Accidental public resource | future edits | validations (CIDR refusal, subnet count, private defaults), blocking trivy-config in CI | CI jobs; §10 checks | reviewer merges bad change — two-person rule recommended (owner process) | revert + apply |
| 16 | Backup compromise / data loss | snapshots, PITR | encrypted snapshots, tags, retention, deletion_protection, no-final-snapshot only staging | runbook steps 8+11 | AZ/region event beyond retention — Wave 8 cross-region | PITR / snapshot restore |

Every-wave checklist: threats→controls→validation→least-privilege→secrets→
network→supply-chain→rollback→residuals — all covered above + §§3-8.

## 10. Validation record (locally executed; AWS/trivy-binary NOT runnable here)

Executed via committed `scripts/terraform-static-checks.py` (exit 0, re-runnable):
HCL brace/paren balance on all 26 `.tf` files; module wiring cross-check
(every `module.*` output + `var.*` resolves, every required variable fed);
root hygiene (required_version, provider pins, partial backend); CIDR overlap
math (10.20/16 slices inside-VPC + mutually disjoint + legacy/prod-disjoint);
`0.0.0.0/0`/`5432`/`AdministratorAccess`/password/key greps with per-hit
justification (11/6/0/0 hits); `Resource "*"` confined to the 2 KMS key
policies; fmt-canonical approximation (tabs/trailing-space/`=`-alignment);
deployer-policy.json valid, no admin, bucket templated. Plus: edited workflow
YAML-parsed + SHA/permissions/blocking assertions; backend 17/17 + frontend
16/16 + frontend build re-run (no app change).
NOT RUN — ENVIRONMENT LIMITATION: `terraform fmt/validate/init` (no binary,
no registry network — binary CDNs blocked, only `api.github.com` reachable),
tflint, trivy-config binary. These run BLOCKING in CI on first push
(`terraform-foundation`, `trivy-config-foundation`) and user-side per runbook.
