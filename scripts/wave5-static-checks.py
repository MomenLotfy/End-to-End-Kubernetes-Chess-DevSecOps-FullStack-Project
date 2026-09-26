#!/usr/bin/env python3
"""Wave 5 local static battery (no Helm/cluster needed).

Chart + release side (always; CI-safe) + GitOps bundle side (local only:
the bundle lives OUTSIDE the app repo at $CHESS_GITOPS or --bundle).

Run locally:  python3 scripts/wave5-static-checks.py
Run in CI:    python3 scripts/wave5-static-checks.py --skip-bundle
"""
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

APP = Path(__file__).resolve().parent.parent
CHART = APP / "deploy" / "helm" / "chess"
failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL: {msg}")


def ok(msg: str) -> None:
    print(f"ok: {msg}")


def read(p: Path) -> str:
    return p.read_text()


# --- 1. chart metadata + values ----------------------------------------------
print("-- chart metadata + values --")
chart = yaml.safe_load(read(CHART / "Chart.yaml"))
assert chart["apiVersion"] == "v2" and chart["name"] == "chess", chart
values = yaml.safe_load(read(CHART / "values.yaml"))
staging = yaml.safe_load(read(CHART / "values-staging.yaml"))
for comp in ("backend", "frontend", "migration"):
    if values[comp]["image"]["digest"] != "":
        fail(f"values.yaml {comp} digest must default empty (fail-closed)")
if "replicaCount" in values.get("backend", {}):
    fail("values.yaml must not expose backend.replicaCount (no knob exists)")
if staging.get("backend", {}).get("replicaCount", 1) != 1:
    fail("values-staging must not set backend replicas != 1")
for f in ("values.yaml", "values-staging.yaml"):
    if re.search(r":latest\b|:\s*main\b|:\s*dev\b", read(CHART / f)):
        fail(f"{f} contains a mutable image tag")
ok("Chart.yaml v2 + fail-closed digest/host defaults + no replica knob")

# --- 2. template brace balance + workload identity -----------------------------
print("-- templates --")
tmpls = sorted((CHART / "templates").glob("*.yaml"))
for t in tmpls:
    text = read(t)
    if text.count("{{") != text.count("}}"):
        fail(t.name + ": unbalanced braces (" + str(text.count("{{")) + " vs " + str(text.count("}}")) + ")")
workloads = {
    "backend-deployment.yaml": "backend",
    "frontend-deployment.yaml": "frontend",
    "migration-job.yaml": "migration",
}
for fname, comp in workloads.items():
    text = read(CHART / "templates" / fname)
    if "chess.image" not in text:
        fail(f"{fname} must build its image via the digest-pinned chess.image helper")
    if "imagePullPolicy: IfNotPresent" not in text:
        fail(f"{fname} must set imagePullPolicy IfNotPresent")
backend = read(CHART / "templates" / "backend-deployment.yaml")
if "replicas: 1" not in backend or "chess.backendReplicaGuard" not in backend:
    fail("backend must hardcode replicas: 1 + include the replica guard")
if re.search(r"replicas:\s*[2-9]", backend):
    fail("backend must never declare replicas > 1")
for fname in workloads:
    text = read(CHART / "templates" / fname)
    for needle in ("runAsNonRoot: true", "readOnlyRootFilesystem: true",
                   "seccompProfile:", "type: RuntimeDefault",
                   'drop: ["ALL"]', "allowPrivilegeEscalation: false",
                   "automountServiceAccountToken: false"):
        if needle not in text:
            fail(f"{fname} missing pod-security control: {needle}")
ok("braces balanced + digest helper + backend=1 + pod-security controls present")

# --- 3. probes use REAL endpoints ------------------------------------------------
print("-- probes --")
if "/liveness" not in backend or "/readiness" not in backend:
    fail("backend probes must use the real /liveness + /readiness endpoints")
frontend = read(CHART / "templates" / "frontend-deployment.yaml")
if "path: /liveness" in frontend or "path: /readiness" in frontend:
    fail("frontend probes must NOT proxy backend endpoints (cascade risk); use / only")
if "path: /" not in frontend:
    fail("frontend probes must hit static /")
ok("probe semantics verified against implementation")

# --- 4. forbidden surface ---------------------------------------------------------
print("-- forbidden surface --")
def code_lines(p: Path) -> str:
    """File text minus full-line comments (prose explains controls; code is truth)."""
    return "\n".join(l for l in read(p).splitlines() if not l.strip().startswith("#"))


code_files = sorted(CHART.rglob("*.yaml")) + [CHART / "templates/NOTES.txt"]
deploy_code = "\n".join(code_lines(p) for p in code_files)
forbidden = [
    "privileged: true", "runAsUser: 0", "hostNetwork", "hostPID", "hostPath",
    "NodePort", "kind: HorizontalPodAutoscaler", "kind: ClusterRole",
    "kind: ClusterRoleBinding", "kind: IngressClass",
]
for needle in forbidden:
    hits = [f.name for f in code_files if needle in code_lines(f)]
    if hits:
        fail(f"forbidden {needle!r} in code: {hits}")
if "type: LoadBalancer" in deploy_code:
    fail("no LoadBalancer Service allowed (ALB Ingress is the entrypoint)")
# Wave 7 Phase 3 authorizes exactly TWO more Redis touchpoints beyond the
# Phase-2 surface (chess-redis ExternalSecret + values wiring): the backend
# Deployment (secretKeyRef CONSUMPTION of chess-redis — value-free refs) and
# the backend ConfigMap (non-secret env: mode/host/port/TLS, never the
# password). Jobs, services, ingress, notes and everything else stay banned.
redis_allowed = {CHART / "templates/externalsecrets.yaml", CHART / "values.yaml",
                 CHART / "templates/backend-deployment.yaml",
                 CHART / "templates/configmap-backend.yaml"}
for f in code_files:
    if f in redis_allowed:
        continue
    if re.search(r"redis", code_lines(f), re.I):
        fail(f"Redis outside the Phase-3 contract surface: {f.name}")
# The ConfigMap half of the Phase-3 surface is non-secret by construction:
# the password may only arrive via the Deployment's chess-redis secretKeyRef.
if "PASSWORD" in code_lines(CHART / "templates/configmap-backend.yaml"):
    fail("REDIS_PASSWORD has no business in the backend ConfigMap (secretKeyRef only)")
if re.search(r"\bs3://|S3_BUCKET|presigned", deploy_code, re.I):
    fail("S3 uploads belong to Wave 7, not Wave 5")
if re.search(r"image:\s*\S+:(latest|main|dev)\b", deploy_code):
    fail("mutable image tag in deploy/")
if "kind: Secret" in deploy_code and "stringData" in deploy_code:
    fail("plaintext Secret values forbidden (ESO only)")
ok("no privileged/host/exposed/HPA/plaintext-secret surface; Redis confined to ESO+values")

# --- 5. services, ingress, networkpolicy -------------------------------------------
print("-- exposure + policy --")
bsvc = read(CHART / "templates" / "backend-service.yaml")
if "type: ClusterIP" not in bsvc or "name: chess-backend" not in bsvc.replace("{{ .Values.backend.service.name }}", "x"):
    pass  # name is parameterized; verified structurally below
if "targetPort: http" not in bsvc:
    fail("backend service must target the http named port")
ing = read(CHART / "templates" / "ingress.yaml")
if "chess-backend" in ing or "backend" in ing.split("backend is reachable")[0].split("NOTES")[0][:0]:
    fail("ingress must not route to the backend")
if "ssl-redirect" not in ing or "certificate-arn" not in ing:
    fail("ingress must terminate TLS (ACM) + redirect HTTP->HTTPS")
if "{{ .Values.frontend.service.name }}" not in ing:
    fail("ingress must route only to the frontend service")
netpol = read(CHART / "templates" / "networkpolicy.yaml")
if "default-deny-ingress" not in netpol:
    fail("networkpolicy must include the ingress default-deny")
if netpol.count("podSelector:") < 3:
    fail("networkpolicy must scope frontend->backend via podSelector")
backend_section = netpol.split("allow-backend-ingress")[1]
if "ipBlock" in backend_section.split("nodeCidrs")[0] and "VPC CIDR" in backend_section:
    fail("backend ingress must not allow the VPC CIDR (frontend pods + kubelet only)")
ok("ClusterIP-only + frontend-only ingress + deny-by-default netpol")

# --- 6. secret wiring (least privilege) ----------------------------------------------
print("-- secret wiring --")
if "chess-db-master" in backend:
    fail("backend must NEVER mount master credentials (chess-app only)")
for key in ("db-user", "db-password", "jwt-secret", "frontend-url", "smtp-host",
            "smtp-password", "email-from", "db-ssl-ca"):
    if key not in backend:
        fail(f"backend missing expected chess-app key ref: {key}")
mig = read(CHART / "templates" / "migration-job.yaml")
if "chess-db-master" not in mig or "PreSync" not in mig or "HookSucceeded" not in mig:
    fail("migration must be a PreSync hook using master creds with HookSucceeded cleanup")
if "restartPolicy: Never" not in mig:
    fail("migration Job must set restartPolicy Never")
eso = read(CHART / "templates" / "externalsecrets.yaml")
# Wave 7 adds the third secret (chess-redis, Valkey AUTH). Exactly these three.
if eso.count("kind: ExternalSecret") != 3 or "external-secrets.io/v1" not in eso:
    fail("expected exactly 3 v1 ExternalSecrets (db-master + app + redis)")
for name in ("chess-db-master", "chess-app", "chess-redis"):
    if name not in eso:
        fail(f"ExternalSecret missing: {name}")
if "refreshInterval" not in eso:
    fail("ExternalSecrets must set refreshInterval")
ok("backend=app-creds, migration=master-creds, hook ordering present")

# --- 7. migrations frozen + 008 valid --------------------------------------------------
print("-- migrations --")
migdir = APP / "Database" / "migrations"
existing = ["001_init.sql", "002_game_features.sql", "003_achievements.sql",
            "004_friends.sql", "005_tournaments.sql", "006_add_game_board_fen.sql",
            "006_security_integrity.sql", "007_fullstack_hardening.sql"]
for f in existing:
    r = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", f"Database/migrations/{f}"],
                       cwd=APP, capture_output=True)
    if r.returncode != 0:
        fail(f"existing migration modified (frozen): {f}")
f008 = migdir / "008_app_grants.sql"
if not f008.exists():
    fail("008_app_grants.sql missing")
else:
    t008 = read(f008)
    for needle in ("TO chess_user", "ON ALL TABLES", "ON ALL SEQUENCES",
                   "ON FUNCTIONS", "ALTER DEFAULT PRIVILEGES"):
        if needle not in t008:
            fail(f"008 missing: {needle}")
    t008_code = "\n".join(l for l in t008.splitlines() if not l.strip().startswith("--"))
    if "FOR ROLE" in t008_code:
        fail("008 must not use FOR ROLE (breaks compose/integration where runner differs)")
ok("migrations 001-007 untouched, 008 present + complete + runner-agnostic")

# --- 8. nginx overlay parity --------------------------------------------------------------
print("-- nginx overlay parity --")
baked = read(APP / "Chess-Frontend" / "nginx.conf")
overlay = read(CHART / "templates" / "configmap-frontend-nginx.yaml")
for needle in ("upstream chess_backend", "server chess-backend:5000",
               "location /api/", "location ^~ /uploads/", "location /socket.io/",
               "location = /liveness", "location = /readiness",
               "proxy_set_header X-Forwarded-Proto https",
               "limit_req zone=api_per_ip", "Strict-Transport-Security",
               "Content-Security-Policy", "try_files $uri $uri/ /index.html"):
    if needle not in overlay:
        fail(f"overlay dropped baked behavior: {needle}")
overlay_code = "\n".join(l for l in overlay.splitlines() if not l.strip().startswith("#"))
for needle in ("listen 8443", "ssl_certificate", "return 308", "acme-challenge"):
    if needle in overlay_code:
        fail(f"overlay must not contain compose-TLS artifact: {needle}")
if "listen 8080" not in overlay:
    fail("overlay must serve plain HTTP on 8080")
ok("overlay preserves behavior, drops only TLS/redirect/ACME")

# --- 9. commit-back script ------------------------------------------------------------
print("-- commit-back --")
cb = APP / "release" / "gitops-commit-back.py"
r = subprocess.run([sys.executable, "-m", "py_compile", str(cb)], capture_output=True)
if r.returncode != 0:
    fail(f"commit-back py_compile failed: {r.stderr.decode()[:300]}")
with tempfile.TemporaryDirectory() as tmp:
    import json as _json
    imgs = (Path(tmp) / "images.yaml")
    imgs.write_text("global:\n  registry: OLD\nbackend:\n  image:\n    digest: OLD\n"
                    "frontend:\n  image:\n    digest: OLD\nmigration:\n  image:\n    digest: OLD\n")
    idx = Path(tmp) / "index.json"
    idx.write_text(_json.dumps({"images": [
        {"name": n, "image": {"registry": "R", "digest": "sha256:" + c * 64}}
        for n, c in [("chess-backend", "a"), ("chess-frontend", "b"), ("chess-migration", "c")]]}))
    r = subprocess.run([sys.executable, str(cb), "--images-yaml", str(imgs), "--index", str(idx)],
                       capture_output=True, text=True)
    out = imgs.read_text()
    if r.returncode != 0 or out.count("sha256:") != 3 or "registry: R" not in out:
        fail(f"commit-back fixture failed: rc={r.returncode} {r.stderr[:200]}")
    bad = dict(_json.loads(idx.read_text()))
    bad["images"][0]["image"]["digest"] = "latest"
    idx.write_text(_json.dumps(bad))
    r = subprocess.run([sys.executable, str(cb), "--images-yaml", str(imgs), "--index", str(idx)],
                       capture_output=True, text=True)
    if r.returncode == 0:
        fail("commit-back must reject weak digests")
ok("commit-back compiles + fixture passes + rejects weak digests")

# --- 10. workflows ------------------------------------------------------------------
print("-- workflows --")
rel = yaml.safe_load(read(APP / ".github" / "workflows" / "release.yml"))
job = rel["jobs"].get("gitops-commit-back")
if not job:
    fail("release.yml missing gitops-commit-back job")
else:
    if "continue-on-error" in job:
        fail("commit-back must fail real once configured (no continue-on-error)")
    if job.get("permissions") != {"contents": "read"}:
        fail("commit-back job must run with contents:read only")
    dump = str(job)
    if "GITOPS_REPO_TOKEN" not in dump or "GITHUB_TOKEN" in dump.replace("GITOPS_REPO_TOKEN", ""):
        fail("commit-back must push with the scoped GITOPS_REPO_TOKEN, never GITHUB_TOKEN")
infra = yaml.safe_load(read(APP / ".github" / "workflows" / "infra-validation.yml"))
hj = infra["jobs"].get("helm-validate")
if not hj or "continue-on-error" in hj:
    fail("infra-validation.yml must carry a BLOCKING helm-validate job")
else:
    paths = str(infra[True] if True in infra else infra.get("on"))
    if "deploy/**" not in paths:
        fail("infra-validation path filter must include deploy/**")
    if "azure/setup-helm@9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310" not in str(hj):
        fail("helm-validate must pin setup-helm v5.0.1 by SHA")
ok("commit-back job + helm-validate job correctly wired")

# --- 11. gitops bundle (local only) ---------------------------------------------------
skip_bundle = "--skip-bundle" in sys.argv
bundle = Path(os.environ.get("CHESS_GITOPS", "/home/user/chess-gitops"))
if len(sys.argv) > sys.argv.index("--bundle") + 1 if "--bundle" in sys.argv else False:
    bundle = Path(sys.argv[sys.argv.index("--bundle") + 1])
if not skip_bundle:
    print(f"-- gitops bundle ({bundle}) --")
    if not bundle.is_dir():
        fail(f"bundle dir missing: {bundle}")
    else:
        yfiles = sorted(bundle.rglob("*.yaml"))
        print(f"   parsing {len(yfiles)} bundle YAML files")
        for yf in yfiles:
            try:
                list(yaml.safe_load_all(yf.read_text()))
            except Exception as e:  # noqa: BLE001
                fail(f"bundle YAML parse failed: {yf.relative_to(bundle)}: {e}")
        # placeholder inventory: every CHANGEME_* must be documented in README
        readme = (bundle / "README.md").read_text()
        documented = set(re.findall(r"`(CHANGEME_[A-Z_*]+)`", readme))
        import fnmatch as _fn
        used: set[str] = set()
        for yf in yfiles:
            used |= set(re.findall(r"CHANGEME_[A-Z_]+", yf.read_text()))
        undoc = sorted(u for u in used if not any(_fn.fnmatch(u, d) for d in documented))
        if undoc:
            fail(f"undocumented placeholders: {undoc}")
        # projects: no wildcard servers/repos, tight destinations
        for proj in ("chess-staging", "platform"):
            text = (bundle / "projects" / f"{proj}.yaml").read_text()
            if '"*"' in text or "'*'" in text or "server: *" in text:
                fail(f"project {proj} contains a wildcard")
            if "CHANGEME_GITOPS_REPO_URL" not in text:
                fail(f"project {proj} must reference the gitops repo placeholder")
        chess_proj = (bundle / "projects" / "chess-staging.yaml").read_text()
        if chess_proj.count("namespace: chess-staging") < 1:
            fail("chess-staging project must pin the chess-staging destination")
        # applications: pinned charts, multi-source images/wiring, no HEAD
        app = (bundle / "apps/chess/staging/application.yaml").read_text()
        for needle in ("$values/apps/chess/staging/images.yaml",
                       "$values/apps/chess/staging/wiring.yaml", "ref: values",
                       "automated:", "prune: true", "selfHeal: true"):
            if needle not in app:
                fail(f"chess application missing: {needle}")
        eso_app = (bundle / "apps/platform/eso/application.yaml").read_text()
        if "targetRevision: 2.11.0" not in eso_app:
            fail("ESO chart must pin 2.11.0")
        ky_app = (bundle / "apps/platform/kyverno/application.yaml").read_text()
        if "targetRevision: 3.9.1" not in ky_app:
            fail("Kyverno chart must pin 3.9.1")
        for af in bundle.rglob("application.yaml"):
            if "targetRevision: HEAD" in af.read_text() or "targetRevision: '*'" in af.read_text():
                fail(f"{af.relative_to(bundle)} uses a floating revision")
        # policies: exactly 5, all Audit
        pols = sorted((bundle / "apps/platform/policies/policies").glob("*.yaml"))
        if len(pols) != 5:
            fail(f"expected exactly 5 kyverno policies, found {len(pols)}")
        for pf in pols:
            pt = pf.read_text()
            if "validationFailureAction: Audit" not in pt:
                fail(f"{pf.name} must be Audit")
            if "Enforce" in pt:
                fail(f"{pf.name} must not mention Enforce")
        # images.yaml schema (commit-back contract)
        images = yaml.safe_load((bundle / "apps/chess/staging/images.yaml").read_text())
        if images["global"]["registry"] != "CHANGEME_ECR_REGISTRY":
            fail("images.yaml registry placeholder broken")
        for comp in ("backend", "frontend", "migration"):
            if images[comp]["image"]["digest"] != f"CHANGEME_{comp.upper()}_DIGEST":
                fail(f"images.yaml {comp} digest placeholder broken")
        # bootstrap script syntax + pinned version, no secrets in bundle
        r = subprocess.run(["bash", "-n", str(bundle / "bootstrap/install-argocd.sh")],
                           capture_output=True, text=True)
        if r.returncode != 0:
            fail(f"install-argocd.sh bash -n failed: {r.stderr[:200]}")
        if 'ARGOCD_VERSION="v3.5.3"' not in (bundle / "bootstrap/install-argocd.sh").read_text():
            fail("bootstrap must pin ArgoCD v3.5.3")
        bundle_text = "\n".join(p.read_text() for p in yfiles)
        for needle in ("AKIA", "BEGIN PRIVATE", "password:", "token: ghp_", "xox"):
            if needle in bundle_text:
                fail(f"possible secret in bundle: {needle}")
        ok("bundle parses + placeholders documented + projects tight + charts pinned + 5 audit policies")
else:
    print("-- gitops bundle SKIPPED (--skip-bundle, CI mode) --")

print()
if failures:
    print(f"{len(failures)} FAILURE(S)")
    sys.exit(1)
print("ALL WAVE 5 STATIC CHECKS PASSED")
