# Wave 3 Security Baseline — Trusted ECR Release Pipeline

Date: 2026-09-22 · Scope: release workflow + OIDC/IAM/ECR package · App behavior: **unchanged**
Gate: `docs/05-architecture-gate.md` · Prior: `docs/security/wave2-baseline.md`

## 1. Release architecture (as built)

```text
push → main (post-`ci` merge) ─┬─ release[backend|frontend|migration] ────┐
workflow_dispatch ─────────────┘  environment: production                   │
  build(local) → trivy image BLOCK → SBOM(SPDX) → assume role (OIDC) →     │
  push ECR:sha-<short> → capture digest → cosign sign digest →              │
  cosign attest SBOM → metadata JSON ──────────────────────────────────────┘
                                  └─ release-index: merge 3 metadata → index + summary
PRs NEVER trigger this workflow. Forks cannot publish, sign, or assume the role.
```

## 2. OIDC & IAM design

- Trust (`release/iam-trust-policy.json`): two `StringEquals` statements — repo+`ref:main`
  and repo+`environment:production`, audience `sts.amazonaws.com`. No wildcards, no other
  repos, no other branches. Worst case of workflow compromise: attacker pushes images to
  3 repos (still scanned + signed under the repo identity — detectable, not stealthy).
- Permissions (`release/iam-permissions-policy.json`): `GetAuthorizationToken` on `*`
  (AWS-mandated, login only) + 10 push/pull/describe actions scoped to the 3 repo ARNs.
  **Cannot**: `BatchDeleteImage`, `DeleteRepository`, `CreateRepository`, anything outside ECR.
  Infra administration (Wave 4) gets a SEPARATE role — release can never modify EKS/VPC/RDS.
- Credential hygiene: zero static keys. `configure-aws-credentials` v6.3.0 (SHA-pinned) mints
  short-lived creds per job; `docker login` uses a 12-hour ECR token via stdin (never logged).

## 3. Tagging, digest, SBOM, signing

- Tag `sha-<12>` (unique per commit, human navigation); **digest is deployment truth**.
  Mapping commit→tag→digest→SBOM→signature lives in `release-metadata-<name>.json`
  (schema `chess-release-metadata/v1`) + merged `release-index.json` (90-day artifacts).
- SBOM: Syft via `anchore/sbom-action` v0.24.2, SPDX-JSON per image, sha256 recorded in
  metadata, attested to the digest (`--type https://spdx.dev/Document`, in-toto canonical).
- Signing: cosign v3.1.3 keyless (Fulcio/Rekor, no private keys anywhere). Identity bound to
  `https://github.com/<repo>/.github/workflows/release.yml@<ref>`; verification commands in
  `release/README.md`. Admission enforcement deferred to Wave 5/8 by design.
- Rollback (pre-K8s): previous digest from `release-index` history → `docker pull <ref>@<digest>`;
  Wave 5 promotes this to GitOps revision rollback.

## 4. Policies

- Vuln: trivy image HIGH/CRITICAL `exit-code: 1` **pre-push** (vulnerable bytes never reach ECR
  tags); SARIF to Security tab. `.trivyignore`: none exists; creation requires CVE + reason +
  expiry + reviewer (Wave 2 rule, unchanged).
- Reproducibility: `npm ci` lockfiles, build-arg `GIT_SHA` recorded in OCI labels + metadata;
  base-image digest pinning still deferred (needs Docker host; Wave 1 §9) — releases record
  the resolved image config digest implicitly via the pushed manifest, so every artifact stays
  byte-identical and re-verifiable regardless.
- ECR: AES256 at rest, scan-on-push (defense in depth behind the blocking pre-push scan),
  lifecycle keep-30/expire-untagged-7d, no public access, no repo policy (IAM-only access).
  Tag mutability MUTABLE (documented deviation: rollback re-push escape hatch; unused in
  normal path since tags are unique per commit).

## 5. Credential audit (Wave 3)

Active workflows reference exactly one secret: `secrets.GITHUB_TOKEN` (gitleaks).
Provably unreferenced (referenced only by the 4 workflows deleted in Wave 2, `ed8317d`):
`NPM_TOKEN` — owner should delete it in repo Settings unless an external process uses it.
Retired Jenkinsfiles (`Jenkins-Pipeline-Code/`) reference Jenkins-side credential IDs
`aws-key`, `docker`, `github`, `sonar-token` plus a `slackNotify` integration and a
`YOUR_DOCKERHUB_USERNAME` placeholder — those live in the retired Jenkins, not in this
repo; no values exist here. If the keypair behind `aws-key` was real, rotate it in IAM. `git grep` for
`AKIA|aws_secret|BEGIN .*PRIVATE` across history: no live credentials (only the known
`.env.example` placeholder comment). No historical exposure of AWS keys found in-tree;
as precaution the owner should confirm no such keys were ever added to repo Settings
(Settings → Secrets → audit list) and rotate anything unknown.

## 6. Threat / control / residual-risk matrix

| # | Threat | Attack surface | Control | Validation | Residual risk | Rollback |
|---|---|---|---|---|---|---|
| 1 | Stolen AWS creds | OIDC creds in runner | Short-lived OIDC (no static keys); push-only role; ephemerals runners | policy JSON valid; trust has no wildcards (asserted) | Compromised job = push-only abuse window (~1h creds) — detectable via ECR push events | disable role trust; delete pushed tags (admin) |
| 2 | OIDC trust abuse (other repo/branch) | IAM trust | Exact-match sub (repo+ref / repo+env), aud pinned | JSON asserted: 2 statements, StringEquals, no `*` | Typo in repo string would fail-closed (deny) — safe direction | update trust policy |
| 3 | Overprivileged release role | IAM | 10 ECR actions on 3 ARNs; no delete/admin | asserted: no Delete/Create/Admin/`ecr:*` | `PutImage` can overwrite same tag in theory — tags unique per commit; digest truth | scope down further anytime |
| 4 | Malicious PR publishes image | release trigger | No `pull_request` trigger; `environment: production` + main-only | YAML asserted | Maintainer pushing malicious main directly — branch protection (owner) is the control | revert commit; superseding release |
| 5 | Poisoned dependency in release | manifests | Wave-2 gates pre-merge (audit high+, dep-review) + pre-push trivy | same policy, re-executed at release | Lockfile-only drift between merge and release re-`npm ci` — deterministic, same tree | prior digest redeploy |
| 6 | Vulnerable image released | ECR | Pre-push trivy block; scan-on-push second net | exit-code 1 asserted in YAML | Zero-day in accepted low/moderate — lifecycle + rebuild cadence | prior digest; `.trivyignore` w/ expiry only |
| 7 | Unsigned/rogue image deployed later | registry | Keyless sign+attest every digest; identity-bound | commands fixed in workflow; verify cmds in README | Rekor/Fulcio outage blocks release (fail-closed, safe) — retry, no bypass | re-sign is impossible w/o rebuild — by design |
| 8 | SBOM mismatch / missing | provenance | SBOM per image, sha256 in metadata, attested to digest | metadata script tested locally w/ fixtures | Artifact expiry (90d) — registry attestation is the durable copy | re-generate SBOM from digest (syft attest verify) |
| 9 | Mutable-tag attack (`latest` confusion) | tags | No `latest` anywhere; unique tags; digest truth | grep: zero `latest` in release path | MUTABLE repos allow overwrite — mitigated by unique tags + digest deploys | digest pinning ignores tags |
| 10 | Malicious/compromised action | supply chain | 5 new refs SHA-pinned (verified via API); Dependabot | 40-char audit on all refs | Action-repo takeover — review Dependabot SHA diffs | pin prior SHA |
| 11 | Leaked build secrets in logs/artifacts | logs, metadata | No secrets in inputs; metadata schema excludes creds; ECR token via stdin | metadata schema review + secret grep | Cosign/Rekor transparency URLs are public-by-design (not sensitive) | n/a |
| 12 | Workflow injection via refs | `run:` blocks | No untrusted interpolation (`github.sha`, matrix only; PR inputs absent) | manual review of all `run:` | Dispatch inputs: none defined — no free-text inputs exist | revert workflow |

## 7. Validation record

Locally executed: release.yml YAML parse + permission assertions; all 5 new action SHAs
verified 40-char via release API; `bash -n` on setup.sh + make-metadata.sh; policy JSON
parse + no-wildcard/no-admin assertions with dummy substitution; make-metadata.sh
functional test with fixtures (valid + invalid digest/commit rejection); bypass grep
(zero `continue-on-error`/`|| true`/`@master`/`latest`/static keys in release path);
executable bits on scripts; backend 17/17 + frontend 16/16 + build re-run (no app change).
NOT RUN (environment limitation): AWS setup.sh execution, OIDC assumption, ECR push,
cosign/SBOM/trivy live runs, docker builds. USER-SIDE AWS VALIDATION REQUIRED: §5 of
`release/README.md` (setup → vars → environment → green release → cosign verify).
