#!/usr/bin/env python3
"""Wave 7 local static battery — scale-out gate (no Helm/cluster/AWS needed).

Phase 2 scope (this file grows with later phases; each phase extends it):
  1. ElastiCache module structure (serverless Valkey, users, secrets, SG)
  2. Private-only placement + 6379 restricted to the EKS cluster SG
  3. Staging wiring (subnets, SG source, ESO ARN, outputs without secrets)
  4. Production planned-only (modules mirrored, roles still empty)
  5. ESO chess-redis contract + RBAC/consumption confinement
  6. NetworkPolicy posture (no 6379 ingress; no egress-policy weakening)
  7. Secret sweep (no credentials in git, values, or outputs)
  8. Phase boundary (pinned Redis deps, confined surface, no HPA, 1 replica)
  9. ESO manifests tracked in git
  10. Phase-3 app integration (adapter, fail-closed lifecycle, rematch,
      metrics+ Helm wiring)
  11. Phase-4 db-truth room cache (hydrate/refresh/presence, websocket-only,
      no stickiness, metrics cataloged)
  12. Phase-5 shared rate limiting (RedisStores over 1 client, fail-open +
      LOUD, no MemoryStore fallback, trust chain pinned, alert + runbook)
  13. Phase-6 bounded graceful shutdown (RUNNING/DRAINING/STOPPING/STOPPED,
      io.close sole closer, preStop trigger-then-sleep, room gate, 22s cap)

Run locally:  python3 scripts/wave7-static-checks.py
Run in CI:    same (blocking job in infra-validation.yml)
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

APP = Path(__file__).resolve().parent.parent
TF = APP / "terraform"
CHART = APP / "deploy" / "helm" / "chess"
EC = TF / "modules" / "elasticache"
failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL: {msg}")


def ok(msg: str) -> None:
    print(f"ok: {msg}")


def read(p: Path) -> str:
    return p.read_text()


def code_lines(p: Path) -> str:
    return "\n".join(line for line in read(p).splitlines() if not line.strip().startswith("#"))


# --- 1. elasticache module structure --------------------------------------------------
print("-- elasticache module --")
for f in ("main.tf", "variables.tf", "outputs.tf"):
    if not (EC / f).exists():
        fail(f"terraform/modules/elasticache/{f} missing")
main = read(EC / "main.tf")
for resource in ('aws_elasticache_serverless_cache" "this"',
                 'aws_elasticache_user" "app"',
                 'aws_elasticache_user_group" "this"',
                 'aws_security_group" "redis"',
                 'aws_vpc_security_group_ingress_rule" "redis_from_eks"',
                 'aws_secretsmanager_secret" "redis"',
                 'aws_secretsmanager_secret_version" "redis"',
                 'random_password" "auth"'):
    if resource not in main:
        fail(f"elasticache module missing resource: {resource}")
if 'engine               = "valkey"' not in main:
    fail('serverless cache engine must be "valkey"')
if "user_group_id" not in main:
    fail("serverless cache must attach the Valkey user group (AUTH)")
if "cache_usage_limits" not in main or "ecpu_per_seconds" not in main:
    fail("serverless cache must set cost guardrails (cache_usage_limits)")
if "-@dangerous" not in main:
    fail("Valkey user access_string must deny @dangerous")
if 'hashicorp/random' not in main or '~> 3.0' not in main:
    fail("elasticache module must pin the random provider (~> 3.0)")
ok("serverless Valkey + users + SM secret + SG + cost caps present")

# --- 2. private-only + 6379 restriction --------------------------------------------------
print("-- redis network boundary --")
# The sanctioned documenting phrase is the only allowed occurrence.
if "0.0.0.0/0" in main.replace("No 0.0.0.0/0 ingress", ""):
    fail("0.0.0.0/0 in elasticache module (Redis must be private)")
if "cidr_blocks" in main:
    fail("cidr_blocks inline ingress forbidden (dedicated rule resource only)")
if "from_port                    = 6379" not in main or "to_port                      = 6379" not in main:
    fail("Redis SG rule must pin from_port/to_port to 6379")
if "referenced_security_group_id = var.allowed_source_security_group_id" not in main:
    fail("6379 ingress source must be var.allowed_source_security_group_id (no IPs)")
if main.count("aws_vpc_security_group_ingress_rule") != 1:
    fail("exactly one Redis ingress rule must exist")
if "aws_elasticache_replication_group" in main or "aws_elasticache_cluster" in main:
    fail("node-based ElastiCache forbidden (serverless only for staging)")
if "subnet_ids         = var.data_subnet_ids" not in main:
    fail("cache must sit in var.data_subnet_ids (private data tier)")
if re.search(r"public", main, re.I):
    fail("the word 'public' must not appear in the Redis module")
ok("6379 from EKS SG only; serverless-only; data-tier subnets; no public surface")

# --- 3. staging wiring ---------------------------------------------------------------------
print("-- staging wiring --")
staging = read(TF / "environments" / "staging" / "main.tf")
if 'module "elasticache"' not in staging:
    fail("staging must instantiate the elasticache module")
for needle in ("data_subnet_ids                  = module.networking.data_subnet_ids",
               "allowed_source_security_group_id = module.eks.cluster_security_group_id",
               "module.elasticache.user_secret_arn"):
    if needle not in staging:
        fail(f"staging wiring missing: {needle}")
if staging.count("module.elasticache.user_secret_arn") != 1:
    fail("redis secret ARN must feed the ESO Resource exactly once in staging")
staging_out = read(TF / "environments" / "staging" / "outputs.tf")
for needle in ("redis_endpoint_address", "redis_user_secret_arn"):
    if needle not in staging_out:
        fail(f"staging output missing: {needle}")
staging_out_code = code_lines(TF / "environments" / "staging" / "outputs.tf")
if re.search(r"password\s*=|secret_string\s*=|connection_string\s*=", staging_out_code, re.I):
    fail("staging outputs must not leak credentials")
for root in ("staging", "production"):
    versions = read(TF / "environments" / root / "versions.tf")
    if 'hashicorp/random' not in versions:
        fail(f"{root} versions.tf must declare the random provider")
ok("staging feeds data subnets + EKS SG + ESO; outputs credential-free")

# --- 4. production planned-only --------------------------------------------------------------
print("-- production planned-only --")
prod = read(TF / "environments" / "production" / "main.tf")
if "DO NOT `terraform apply` this root" not in prod and "DO NOT APPLY" not in prod:
    fail("production root must keep its DO NOT APPLY header")
for needle in ('module "elasticache"', 'module "s3avatars"'):
    if needle not in prod:
        fail(f"production planned parity missing: {needle}")
if "roles = {}" not in prod:
    fail("production iam roles must stay empty (no prod grants before Wave 8)")
prod_out = read(TF / "environments" / "production" / "outputs.tf")
if re.search(r"password|secret_string", prod_out, re.I):
    fail("production outputs must not leak credentials")
ok("prod mirrors modules (planned), grants nothing")

# --- 5. ESO contract + RBAC confinement -------------------------------------------------------
print("-- eso chess-redis --")
eso_text = read(CHART / "templates" / "externalsecrets.yaml")
if eso_text.count("kind: ExternalSecret") != 3:
    fail("expected exactly 3 ExternalSecrets (db-master + app + redis)")
if "name: chess-redis" not in eso_text:
    fail("chess-redis ExternalSecret missing")
for needle in ("eso.redisSecretArn", "property: username", "property: password",
               "creationPolicy: Owner", "deletionPolicy: Retain",
               "argocd.argoproj.io/hook: PreSync", 'sync-wave: "-2"'):
    if needle not in eso_text:
        fail(f"chess-redis contract missing: {needle}")
values = read(CHART / "values.yaml")
if "redisSecretArn" not in values:
    fail("values.yaml must carry eso.redisSecretArn (empty default)")
if re.search(r"^redis:\n  host: \"\"\n  port: 6379", values, re.M) is None:
    fail("values.yaml must carry the redis host/port block (empty host default)")
for secret_host in (CHART / "values.yaml",
                    CHART / "templates" / "configmap-backend.yaml"):
    blob = code_lines(secret_host)
    if re.search(r"AKIA|BEGIN .*PRIVATE|password\s*:\s*\S|passwd", blob, re.I):
        fail(f"possible credential in {secret_host.name}")
# RBAC confinement: only the backend Deployment may ever reference chess-redis
# (Phase 3+). Migration, frontend, configs and notes must never touch it.
for rel in ("templates/migration-job.yaml", "templates/frontend-deployment.yaml",
            "templates/configmap-backend.yaml", "templates/NOTES.txt",
            "templates/ingress.yaml"):
    if "chess-redis" in code_lines(CHART / rel):
        fail(f"chess-redis leaked into {rel} (backend-only contract)")
# Phase 3: the backend Deployment consumes chess-redis (USERNAME+PASSWORD refs).
backend_dep = code_lines(CHART / "templates" / "backend-deployment.yaml")
for needle in ("name: REDIS_USERNAME", "name: REDIS_PASSWORD",
               "secretKeyRef: { name: chess-redis, key: username }",
               "secretKeyRef: { name: chess-redis, key: password }"):
    if needle not in backend_dep:
        fail(f"backend deployment chess-redis wiring missing: {needle}")
ok("chess-redis ESO shaped; backend consumes; others confined; values clean")

# --- 6. networkpolicy posture -------------------------------------------------------------------
print("-- networkpolicy --")
netpol = read(CHART / "templates" / "networkpolicy.yaml")
if "default-deny-ingress" not in netpol:
    fail("ingress default-deny must stay")
if "policyTypes: [Ingress, Egress]" in netpol or "policyTypes: [Egress" in netpol:
    fail("no egress NetworkPolicy may exist (documented RDS-precedent decision)")
if re.search(r"port:\s*6379", code_lines(CHART / "templates" / "networkpolicy.yaml")):
    fail("no 6379 INGRESS may exist (Redis lives off-cluster; SG enforces)")
if "6379" not in netpol or "ElastiCache security group is the enforcement" not in netpol:
    fail("netpol header must document the Redis enforcement decision")
ok("ingress deny-by-default kept; 6379 off-cluster via SG (documented)")

# --- 7. secret sweep ------------------------------------------------------------------------------
print("-- secret sweep --")
blobs = "\n".join(read(p) for p in list(EC.glob("*.tf"))
                  + [CHART / "templates" / "externalsecrets.yaml",
                     CHART / "values.yaml"])
if re.search(r"AKIA|BEGIN .*PRIVATE|passwd", blobs):
    fail("hardcoded credential pattern in Redis surface")
if re.search(r"password\s*=\s*\"[^\"]+\"", "\n".join(code_lines(p) for p in EC.glob("*.tf"))):
    fail("quoted password literal in elasticache module")
if "rediss://" in blobs and "@" in blobs:
    fail("credential-bearing Redis URL in git")
ok("no credentials in the Redis surface")

# --- 8. phase boundary -------------------------------------------------------------------------------
print("-- phase boundary --")
backend_pkg = read(APP / "Chess-Backend" / "package.json")
pkg = json.loads(backend_pkg)
for dep, pinned in (("ioredis", "6.0.0"), ("@socket.io/redis-adapter", "8.3.0"),
                     ("rate-limit-redis", "4.3.1")):
    if pkg["dependencies"].get(dep) != pinned:
        fail(f"{dep} must pin exactly {pinned} (got {pkg['dependencies'].get(dep)})")
if "kind: HorizontalPodAutoscaler" in code_lines(CHART / "templates" / "backend-deployment.yaml"):
    fail("HPA forbidden before Phase 9")
backend_dep = code_lines(CHART / "templates" / "backend-deployment.yaml")
if "replicas: 1" not in backend_dep:
    fail("backend must still pin replicas: 1 (Phase 7 gate)")
if "RollingUpdate" in backend_dep:
    fail("RollingUpdate forbidden before Phase 8")
# Redis integration is confined to the sanctioned Phase 3 surface + the
# Phase 5 limiter service (gate advancement, not weakening: the RedisStore
# lives ONLY there; the hypothetical middleware file is still banned).
redis_hits = sorted(str(p.relative_to(APP / "Chess-Backend")) for p in (APP / "Chess-Backend" / "src").rglob("*.js")
                    if re.search(r"redis", code_lines(p), re.I))
sanctioned = sorted([
    "src/config/logSanitize.js",  # pre-existing credential-URL redaction
    "src/metrics/index.js", "src/metrics/redis.js",
    "src/server.js", "src/services/redis.js", "src/services/rematchVotes.js",
    "src/services/rateLimit.js",
    "src/socket/gameSocket.js",
])
if redis_hits != sanctioned:
    fail(f"Redis surface drift: {redis_hits}")
if (APP / "Chess-Backend" / "src" / "middleware" / "redisRateLimit.js").exists():
    fail("limiter service must live at src/services/rateLimit.js (no middleware copy)")
ok("deps pinned; Redis surface confined; no HPA; replicas still 1; Wave 8 untouched")

# --- 9. ESO manifests tracked in git --------------------------------------------------------------
print("-- eso manifests tracked --")
# Regression guard: the broad *secret* gitignore once silently dropped all 4
# ESO manifests from git. They are value-free wiring (remoteRefs only) and
# MUST be tracked; the .gitignore negations + this check pin that forever.
tracked = subprocess.run(["git", "ls-files"], cwd=APP, capture_output=True, text=True).stdout.splitlines()
for rel in ("deploy/helm/chess/templates/externalsecrets.yaml",
            "deploy/helm/chess/templates/secretstore.yaml",
            "deploy/helm/chess-observability/templates/externalsecrets.yaml",
            "deploy/helm/chess-observability/templates/secretstore.yaml"):
    if rel not in tracked:
        fail(f"ESO manifest not tracked in git (gitignore leak): {rel}")
ok("4 ESO manifests tracked (no silent gitignore drop)")

# --- 10. phase-3 app integration ----------------------------------------------------------------
print("-- phase-3 app integration --")
svc = code_lines(APP / "Chess-Backend" / "src" / "services" / "redis.js")
for needle in ('mode === "local"', '.duplicate()', "adapter-pub", "adapter-sub",
               '"store"', "connectRedisOrFail", "closeRedisClients",
               "plaintext Redis is forbidden in production",
               "FATAL: REDIS_HOST is required", "FATAL: REDIS_PASSWORD is required",
               "SOCKET_ADAPTER must be local|redis",
               "tls: config.tls ? {} : undefined", "FATAL: Redis unavailable at startup",
               "authConfigured", "withTimeout"):
    if needle not in svc:
        fail(f"services/redis.js missing contract: {needle}")
if re.search(r"rejectUnauthorized\s*:\s*false", svc):
    fail("TLS verification must never be disabled")
describe = svc.split("function describeConfig")[1].split("function buildOptions")[0]
if "password" in describe.lower():
    fail("describeConfig must never carry the password")
rematch = code_lines(APP / "Chess-Backend" / "src" / "services" / "rematchVotes.js")
for needle in ('"rematch:"', "REMATCH_TTL_SECONDS = 3600", ".expire(",
               "class RematchUnavailable", "throw new RematchUnavailable(",
               "Refusing rematch key", "Refusing rematch vote",
               "SOCKET_ADAPTER must be local|redis",
               "NO local fallback"):
    if needle not in rematch:
        fail(f"services/rematchVotes.js missing contract: {needle}")
gs = code_lines(APP / "Chess-Backend" / "src" / "socket" / "gameSocket.js")
for banned in ("room.rematchVotes", "rematchVotes: new Set", "room.rematchVotes."):
    if banned in gs:
        fail(f"in-memory rematch Set still present: {banned}")
for needle in ("require(\"../services/rematchVotes\")", "RematchUnavailable",
               "\"Rematch temporarily unavailable\"", "persistMoveAtomic", "claimBlack",
               "finalizeGameAtomic", "SELECT", "FOR UPDATE", "REMATCH_QUORUM"):
    if needle not in gs:
        fail(f"gameSocket.js missing Phase 3 contract: {needle}")
srv = code_lines(APP / "Chess-Backend" / "src" / "server.js")
for needle in ("createAdapter", "initRematchVotes", "connectRedisOrFail",
               "closeRedisClients", "redisReady()"):
    if needle not in srv:
        fail(f"server.js missing Phase 3 wiring: {needle}")
mets = code_lines(APP / "Chess-Backend" / "src" / "metrics" / "index.js")
for needle in ("redis_client_errors_total", "redis_connected", "redis_reconnects_total",
               "redis_command_duration_seconds", "rematch_redis_errors_total"):
    if needle not in mets:
        fail(f"metrics/index.js missing Redis series: {needle}")
menums = code_lines(APP / "Chess-Backend" / "src" / "metrics" / "redis.js")
if '"adapter-pub", "adapter-sub", "store"' not in menums:
    fail("metrics/redis.js must fix the 3-client label enum")
if re.search(r"gameId|userId|socketId|roomId", menums + mets):
    fail("identity labels forbidden in Redis metrics")
catalog = read(APP / "docs" / "observability" / "telemetry-catalog.md")
for metric in ("redis_client_errors_total", "redis_connected", "redis_reconnects_total",
               "redis_command_duration_seconds", "rematch_redis_errors_total"):
    if f"`{metric}`" not in catalog:
        fail(f"telemetry catalog missing `{metric}`")
cm = code_lines(CHART / "templates" / "configmap-backend.yaml")
for needle in ("SOCKET_ADAPTER", "REDIS_HOST", "REDIS_PORT", 'REDIS_TLS: "true"',
               "requires redis.host (Terraform output", ".Values.backend.socketAdapter",
               ".Values.redis.host"):
    if needle not in cm:
        fail(f"configmap-backend.yaml missing Redis contract: {needle}")
values = read(CHART / "values.yaml")
if "socketAdapter: local" not in values:
    fail("values.yaml must default backend.socketAdapter to local")
for t in ("tests/redis.unit.test.js", "tests/rematchVotes.unit.test.js"):
    if t not in read(APP / "Chess-Backend" / "jest.unit.config.js"):
        fail(f"unit suite missing {t}")
ok("adapter + fail-closed lifecycle; rematch in Redis; metrics cataloged; Helm wired")

# --- 11. phase-4 db-truth room cache -----------------------------------------------------------
print("-- phase-4 room cache --")
gs4 = code_lines(APP / "Chess-Backend" / "src" / "socket" / "gameSocket.js")
for needle in ("buildRoomFromSnapshot", "findRoomSnapshot", "normalizeRoomId",
               "hydrateRoom", "async function getRoom", "refreshRoomFromDb",
               "presenceByUser", "fetchSockets", "PRESENCE_TIMEOUT_MS",
               "treating users as absent", "replayed: true", "eloChange: null",
               "present.has(player.userId)", "hydrating.delete(normalized)"):
    if needle not in gs4:
        fail(f"gameSocket.js missing Phase 4 contract: {needle}")
if "A-Z0-9\\-_]{7}" not in gs4:
    fail("ROOM_ID_FORMAT must match the 7-char base64url-uppercase generator exactly")
if gs4.count("await getRoom(roomId)") != 1:
    fail("ONLY join may hydrate (all other paths are cache-only)")
if gs4.count("getCachedRoom(roomId)") < 5:
    fail("move/resign/game_over/rematch/leave must use cache-only lookup")
if "evictIfSocketless" not in gs4:
    fail("rejected joins must evict socketless rooms (no probe lingering)")
if gs4.count("const live = await refreshRoomFromDb(room)") < 6:
    fail("join/move/resign/game_over/rematch/leave must all refresh off DB truth")
if "activeRooms.get(roomId)" in gs4:
    fail("raw roomId must never key the cache (normalize first)")
model = code_lines(APP / "Chess-Backend" / "src" / "models" / "Game.js")
for needle in ("findRoomSnapshot", "persisted_moves",
               "WHERE g.room_id=$1 AND g.game_mode='multiplayer'"):
    if needle not in model:
        fail(f"models/Game.js missing snapshot contract: {needle}")
sockm = code_lines(APP / "Chess-Backend" / "src" / "metrics" / "socket.js")
for needle in ('"created", "refreshed", "not_found", "invalid", "error"',
               '"ok", "failed"', "onHydration", "onPresenceCheck"):
    if needle not in sockm:
        fail(f"metrics/socket.js missing Phase 4 enums: {needle}")
for metric in ("room_hydrations_total", "presence_checks_total"):
    if metric not in mets:
        fail(f"metrics/index.js missing {metric}")
    if f"`{metric}`" not in catalog:
        fail(f"telemetry catalog missing `{metric}`")
srv4 = code_lines(APP / "Chess-Backend" / "src" / "server.js")
if 'transports: ["websocket"]' not in srv4:
    fail("server.js must pin Socket.io to websocket-only")
fe = code_lines(APP / "Chess-Frontend" / "src" / "utils" / "socket.js")
if 'transports: ["websocket"]' not in fe:
    fail("frontend socket.js must pin transports to websocket-only")
for path, text in (("server.js", srv4), ("frontend socket.js", fe)):
    if '"polling"' in text:
        fail(f"{path} must not configure polling transport")
fetest = read(APP / "Chess-Frontend" / "src" / "utils" / "socket.test.js")
if 'transports: ["websocket"]' not in fetest:
    fail("frontend socket.test.js must pin the websocket-only contract")
ing = code_lines(CHART / "templates" / "ingress.yaml")
if re.search(r"stickiness", ing, re.I):
    fail("ALB stickiness is REJECTED in Phase 4 (websocket-only needs no affinity)")
if "tests/roomHydration.unit.test.js" not in read(APP / "Chess-Backend" / "jest.unit.config.js"):
    fail("unit suite missing tests/roomHydration.unit.test.js")
ok("hydrate+refresh+presence; websocket-only both ends; no stickiness; metrics cataloged")

# --- 12. phase-5 shared rate limiting ---------------------------------------------------------------
print("-- phase-5 shared rate limiting --")
svc = code_lines(APP / "Chess-Backend" / "src" / "services" / "rateLimit.js")
for needle in ("require(\"rate-limit-redis\")", "RedisStore", "createRateLimiters",
               "GLOBAL_LIMITER_SPEC", "ROUTE_LIMITER_SPECS", "LIMITER_NAMES",
               "passOnStoreError", "ratelimit:", "rateLimitDegraded",
               "RATE_LIMIT_REDIS_TIMEOUT_MS", "incrementScriptSha", "getScriptSha",
               "redis_not_ready", "redis_command_failed"):
    if needle not in svc:
        fail(f"services/rateLimit.js missing Phase 5 contract: {needle}")
# No MemoryStore fallback: exactly one construction, inside the local-mode
# branch of the startup selection ternary — nowhere else, no catch blocks.
if svc.count("new MemoryStore") != 1:
    fail("MemoryStore must be constructed exactly once (local-mode branch only)")
if ": new MemoryStore();" not in svc:
    fail("the single MemoryStore must sit in the local branch of the mode ternary")
if "resetExpiryOnChange" in svc:
    fail("services/rateLimit.js must not set resetExpiryOnChange (fixed windows only)")
if re.search(r"""["'](KEYS|SCAN)["']""", svc):
    fail("limiter must never issue KEYS/SCAN (exact-match commands only)")
# Specs -> doc binding: every limiter row in docs/security/rate-limits.md is
# reconstructed from the service specs (change both or the gate fails).
specs = re.findall(
    r'name: "([\w-]+)", route: "([^"]+)", windowMs: (\d+(?: \* \d+)?), limit: (\d+),\s+message: "([^"]+)"', svc)
if len(specs) != 7:
    fail(f"expected 7 limiter specs in services/rateLimit.js (got {len(specs)})")
limits_doc = read(APP / "docs" / "security" / "rate-limits.md")
for name, route, window_expr, limit, message in specs:
    window_ms = eval(window_expr, {"__builtins__": {}})  # "15 * 60000" or "60000"
    row = re.compile(r"\| `" + re.escape(name) + r"` \| `" + re.escape(route)
                     + r"` \| " + str(window_ms) + r" ms \([^)]*\) \| " + limit
                     + r" \| `" + re.escape(message) + r"` \|")
    if not row.search(limits_doc):
        fail(f"rate-limits.md out of sync with service spec: {name}")
# server.js: owns NO rate-limit imports; mounts specs in the preserved order.
srv5 = code_lines(APP / "Chess-Backend" / "src" / "server.js")
for needle in ("createRateLimiters", "GLOBAL_LIMITER_SPEC", "ROUTE_LIMITER_SPECS",
               "trustProxyHops", "limiters.get("):
    if needle not in srv5:
        fail(f"server.js missing Phase 5 wiring: {needle}")
if re.search(r'require\("express-rate-limit"|rate-limit-redis"|new (Memory|Redis)Store', srv5):
    fail("server.js must not import/construct rate-limit stores directly (service owns them)")
if "Number(process.env.TRUST_PROXY_HOPS" in srv5:
    fail("server.js must use the validated trustProxyHops (no inline parse)")
mounts = [srv5.index("limiters.get(GLOBAL_LIMITER_SPEC.name)"), srv5.index("originProtection(origins)"),
          srv5.index("limiters.get(spec.name)")]
if mounts != sorted(mounts):
    fail("mount order must stay: global limiter, originProtection, route limiters")
sec = code_lines(APP / "Chess-Backend" / "src" / "config" / "security.js")
for needle in ("function trustProxyHops", "TRUST_PROXY_HOPS must be an integer 0-9"):
    if needle not in sec:
        fail(f"config/security.js missing trust validation: {needle}")
# No new Redis client/secret/endpoint/DB: the 3-client Phase 3 shape is intact.
rjs = code_lines(APP / "Chess-Backend" / "src" / "services" / "redis.js")
if rjs.count("redisClientFactory(options))") != 2 or rjs.count("pub.duplicate()") != 1:
    fail("Phase 3 client shape drifted (must stay pub + sub-duplicate + store)")
if "clients: { pub, sub, store }" not in rjs:
    fail("Phase 3 clients object drifted (must stay { pub, sub, store })")
# Trust chain pins: backend hops, nginx real_ip (reusing the documented ALB
# source — no new value), ALB append-mode + no client port.
becm = code_lines(CHART / "templates" / "configmap-backend.yaml")
if 'TRUST_PROXY_HOPS: "1"' not in becm:
    fail('configmap-backend.yaml must pin TRUST_PROXY_HOPS: "1"')
nx = code_lines(CHART / "templates" / "configmap-frontend-nginx.yaml")
for needle in ("set_real_ip_from", "real_ip_header X-Forwarded-For",
               "real_ip_recursive on",
               'required "networkPolicies.vpcCidr is required (VPC CIDR; documented ALB source)"'):
    if needle not in nx:
        fail(f"nginx overlay missing real_ip trust fix: {needle}")
for needle in ("limit_req_zone $binary_remote_addr zone=api_per_ip:10m rate=20r/s;",
               "limit_req zone=api_per_ip burst=40 nodelay;"):
    if needle not in nx:
        fail(f"nginx overlay must preserve edge limiting verbatim: {needle}")
ing5 = code_lines(CHART / "templates" / "ingress.yaml")
for needle in ("routing.http.xff_header_processing.mode=append",
               "routing.http.xff_client_port.enabled=false"):
    if needle not in ing5:
        fail(f"ingress.yaml missing ALB XFF pin: {needle}")
# Degradation telemetry: metric + catalog + alert + runbook.
if "rate_limit_degraded_total" not in mets:
    fail("metrics/index.js missing rate_limit_degraded_total")
if "`rate_limit_degraded_total`" not in catalog:
    fail("telemetry catalog missing `rate_limit_degraded_total`")
rules = read(APP / "deploy" / "helm" / "chess-observability" / "templates" / "prometheus-config.yaml")
for needle in ("ChessRateLimitDegraded", "rate_limit_degraded_total",
               "severity: warning", "rate-limit-degraded.md"):
    if needle not in rules:
        fail(f"prometheus rules missing degradation alert piece: {needle}")
rb = APP / "docs" / "runbooks" / "rate-limit-degraded.md"
if not rb.exists():
    fail("docs/runbooks/rate-limit-degraded.md missing")
elif "redis_connected" not in read(rb) or "abuse check" not in read(rb):
    fail("rate-limit-degraded runbook missing companion-signal/abuse-check sections")
# Boundary: hydration/rematch/socket paths unaware of limiting; frontend
# untouched; unit suite covers the phase.
for rel in ("src/socket/gameSocket.js", "src/models/Game.js",
            "src/services/rematchVotes.js"):
    if "rateLimit" in code_lines(APP / "Chess-Backend" / rel):
        fail(f"Phase 5 must not touch {rel}")
fe_hits = [str(p.relative_to(APP)) for p in (APP / "Chess-Frontend" / "src").rglob("*.js")
           if "rate_limit_degraded" in read(p) or "ratelimit:" in read(p)]
if fe_hits:
    fail(f"frontend must not change for Phase 5: {fe_hits}")
if "tests/rateLimit.unit.test.js" not in read(APP / "Chess-Backend" / "jest.unit.config.js"):
    fail("unit suite missing tests/rateLimit.unit.test.js")
ok("7 RedisStores over 1 shared client; fail-open+LOUD; trust chain pinned; alert+runbook; boundary intact")

# --- 13. phase-6 bounded graceful shutdown ------------------------------------------------
print("-- phase-6 graceful shutdown --")
shutdown_src = code_lines(APP / "Chess-Backend" / "src" / "services" / "shutdown.js")
shutdown_mets = code_lines(APP / "Chess-Backend" / "src" / "metrics" / "shutdown.js")
server6 = code_lines(APP / "Chess-Backend" / "src" / "server.js")
http6 = code_lines(APP / "Chess-Backend" / "src" / "metrics" / "http.js")
gs6 = code_lines(APP / "Chess-Backend" / "src" / "socket" / "gameSocket.js")
rjs6 = code_lines(APP / "Chess-Backend" / "src" / "services" / "redis.js")
# The single deliberate closer: exactly one io.close call site, zero direct
# HTTP closes, and no double-close workaround string anywhere in src.
if shutdown_src.count("io.close(") != 1:
    fail("shutdown.js must contain exactly one io.close( call site")
if "server.close(" in shutdown_src:
    fail("shutdown.js must never call server.close( directly")
if "server.close(" in server6:
    fail("server.js must never call server.close( directly")
for src_file in (APP / "Chess-Backend" / "src").rglob("*.js"):
    if "ERR_SERVER_NOT_RUNNING" in read(src_file):
        fail(f"double-close workaround string in {src_file.relative_to(APP)}")
# State machine + controller surface.
for needle in ("RUNNING", "DRAINING", "STOPPING", "STOPPED", "ShutdownDrainError",
               "SHUTDOWN_DRAINING", "closeIdleConnections", "closeAllConnections",
               "enterDraining", "runShutdownSequence", "installShutdownHandlers",
               "drainHandshakeGuard", "drainPacketGuard", "createDrainGateMiddleware",
               "createEnterDrainHandler", "isLoopbackAddress", "poolEnded"):
    if needle not in shutdown_src:
        fail(f"services/shutdown.js missing contract: {needle}")
# Budget: 22s global cap; phase caps sum within it; 5s preStop documented.
if "GLOBAL_BUDGET_MS = 22000" not in shutdown_src:
    fail("application global shutdown budget must be exactly 22000ms")
if "PRESTOP_MS = 5000" not in shutdown_src:
    fail("shutdown.js must document the 5s preStop budget")
caps = {}
for name in ("SETTLE_MS", "HTTP_MS", "ROOM_MS", "SOCKET_MS", "CACHE_MS", "PG_MS"):
    match = re.search(rf"{name} = (\d+)", shutdown_src)
    if not match:
        fail(f"shutdown.js missing phase cap: {name}")
    else:
        caps[name] = int(match.group(1))
if caps and sum(caps.values()) > 22000:
    fail(f"phase caps sum {sum(caps.values())}ms exceeds the 22s global budget")
# PreStop trigger: route + loopback guard + metrics exclusion.
if '"/internal/enter-drain"' not in server6:
    fail("server.js missing the /internal/enter-drain trigger route")
for needle in ('"127.0.0.1"', '"::1"'):
    if needle not in shutdown_src:
        fail(f"shutdown.js missing loopback guard literal: {needle}")
if "/internal/enter-drain" not in http6:
    fail("metrics/http.js must exclude /internal/enter-drain from access metrics")
# PreStop ordering: trigger BEFORE sleep, wget-proven binary, loopback URL.
dep6 = code_lines(CHART / "templates" / "backend-deployment.yaml")
if "preStop:" not in dep6:
    fail("backend deployment missing the preStop lifecycle hook")
else:
    hook = dep6.split("preStop:")[1].split("livenessProbe:")[0]
    for needle in ("wget", "127.0.0.1:5000/internal/enter-drain", "sleep 5"):
        if needle not in hook:
            fail(f"preStop hook missing: {needle}")
    if hook.index("enter-drain") > hook.index("sleep 5"):
        fail("preStop must trigger DRAINING BEFORE sleeping")
if "terminationGracePeriodSeconds: 30" not in read(CHART / "values.yaml"):
    fail("backend termination grace must stay exactly 30s")
# Room gate: rejection error, chain preservation, bounded drain, guards.
for needle in ("ShutdownDrainError", "isDraining()", "drainHandshakeGuard",
               "drainPacketGuard", "isShutdownDrainError",
               "drainRoomOperations(budgetMs", "timedOut"):
    if needle not in gs6:
        fail(f"gameSocket.js missing Phase 6 contract: {needle}")
if "closedClean" not in rjs6:
    fail("services/redis.js close must report an explicit clean/forced result")
# Shutdown telemetry: 4 series in code + catalog.
for metric in ("shutdown_state", "shutdown_rejected_total", "shutdown_phase_total",
               "shutdown_signals_total"):
    if metric not in mets:
        fail(f"metrics/index.js missing {metric}")
    if f"`{metric}`" not in catalog:
        fail(f"telemetry catalog missing `{metric}`")
if '"http", "socket", "room"' not in shutdown_mets:
    fail("metrics/shutdown.js must fix the reject-source label enum")
if '"completed", "timeout", "forced"' not in shutdown_mets:
    fail("metrics/shutdown.js must fix the phase-result label enum")
if "tests/shutdown.unit.test.js" not in read(APP / "Chess-Backend" / "jest.unit.config.js"):
    fail("unit suite missing tests/shutdown.unit.test.js")
# Scale-out gate stays shut: 1 replica, Recreate, no HPA, no backend PDB,
# no RollingUpdate, probes untouched, grace untouched.
if "replicas: 1" not in dep6:
    fail("backend must still pin replicas: 1 (Phase 6 changes nothing here)")
if "type: Recreate" not in dep6:
    fail("backend strategy must stay Recreate")
for banned in ("RollingUpdate", "HorizontalPodAutoscaler"):
    if banned in dep6:
        fail(f"{banned} forbidden in the backend deployment (Phase 6 scope)")
for pdb in (CHART / "templates").glob("*pdb*.yaml"):
    if "backend" in code_lines(pdb).lower():
        fail(f"backend PDB forbidden (found backend reference in {pdb.name})")
for needle in ("path: /liveness", "path: /readiness", "failureThreshold: 5",
               "failureThreshold: 6", "periodSeconds: 15", "periodSeconds: 10"):
    if needle not in dep6:
        fail(f"backend probes must stay untouched (missing: {needle})")
# No new migrations: the migration file set is pinned.
migrations = sorted(p.name for p in (APP / "Database" / "migrations").glob("*.sql"))
pinned_migrations = sorted([
    "001_init.sql", "002_game_features.sql", "003_achievements.sql",
    "004_friends.sql", "005_tournaments.sql", "006_add_game_board_fen.sql",
    "006_security_integrity.sql", "007_fullstack_hardening.sql",
    "008_app_grants.sql",
])
if migrations != pinned_migrations:
    fail(f"migration set drifted (Phase 6 adds none): {migrations}")
# Boundary: frontend, nginx, and rate limiting know nothing of shutdown.
fe_hits = [str(p.relative_to(APP)) for p in (APP / "Chess-Frontend" / "src").rglob("*.js")
           if "enter-drain" in read(p) or "ShutdownDrainError" in read(p)]
if fe_hits:
    fail(f"frontend must not change for Phase 6: {fe_hits}")
if "enter-drain" in code_lines(CHART / "templates" / "configmap-frontend-nginx.yaml"):
    fail("nginx overlay must not change for Phase 6")
if "rateLimit" in shutdown_src:
    fail("shutdown.js must not touch rate limiting")
ok("RUNNING/DRAINING/STOPPING/STOPPED; sole io.close; trigger-then-sleep; room gate; 22s cap; gate shut")

print()
if failures:
    print(f"{len(failures)} FAILURE(S)")
    sys.exit(1)
print("ALL WAVE 7 PHASE-6 STATIC CHECKS PASSED")
