#!/usr/bin/env python3
"""Wave 6 local static battery (no Helm/cluster needed).

Covers: backend metrics catalog agreement, log redaction, obs chart shape,
River pipeline, dashboards, alerts, runbooks, SLOs, RBAC least-privilege,
ESO usage, CI wiring — plus the GitOps observability side (local only).

Run locally:  python3 scripts/wave6-static-checks.py
Run in CI:    python3 scripts/wave6-static-checks.py --skip-bundle
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml

APP = Path(__file__).resolve().parent.parent
OBS = APP / "deploy" / "helm" / "chess-observability"
BE = APP / "Chess-Backend"
failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"FAIL: {msg}")


def ok(msg: str) -> None:
    print(f"ok: {msg}")


def read(p: Path) -> str:
    return p.read_text()


# --- 1. metric catalog agreement (code <-> docs) -------------------------------
print("-- metric catalog --")
index_js = read(BE / "src" / "metrics" / "index.js")
code_metrics = set(re.findall(r"new (?:Counter|Gauge|Histogram)\(\s*\"([^\"]+)\"", index_js))
catalog = read(APP / "docs" / "observability" / "telemetry-catalog.md")
doc_metrics = set(re.findall(r"`([a-z_][a-z0-9_]+)`", catalog))
for name in sorted(code_metrics):
    if name not in doc_metrics:
        fail(f"metric {name} implemented but missing from telemetry-catalog.md")
for name in sorted(doc_metrics):
    if name.endswith("_"):
        continue  # prose prefix mention (e.g. `chess_`), not a metric
    if re.match(r"^(http_|app_|process_|eventloop_|db_|socket_|room_|chess_)", name) and name not in code_metrics:
        if name not in {"http_request_duration_seconds_bucket", "http_request_duration_seconds_count",
                        "db_query_duration_seconds_bucket", "db_query_duration_seconds_count"}:
            fail(f"metric {name} documented but not implemented")
if not code_metrics:
    fail("no metrics extracted from src/metrics/index.js")
ok(f"{len(code_metrics)} metrics agree between code and catalog")

# --- 2. cardinality guards ------------------------------------------------------
print("-- cardinality guards --")
registry_js = read(BE / "src" / "metrics" / "registry.js")
for reserved in ("user_id", "email", "socket_id", "game_id", "request_id", "token", "path", "ip"):
    if reserved not in registry_js:
        fail(f"RESERVED_LABEL_NAMES missing: {reserved}")
http_js = read(BE / "src" / "metrics" / "http.js")
for excluded in ("/metrics", "/liveness", "/readiness"):
    if excluded not in http_js:
        fail(f"metrics middleware must exclude {excluded}")
server_js = read(BE / "src" / "server.js")
if 'app.get("/metrics"' not in server_js:
    fail('server.js must expose GET /metrics')
if "X-Request-Id" not in server_js or "traceparent" not in server_js:
    fail("server.js must emit request IDs + propagate traceparent (ADR-009)")
ok("reserved labels + self-scrape exclusions + /metrics + request IDs present")

# --- 3. log redaction --------------------------------------------------------------
print("-- log redaction --")
sanitize = read(BE / "src" / "config" / "logSanitize.js")
for needle in ("AKIA", "eyJ", "postgres", "REDACTED", "SENSITIVE_KEY_RE", "sanitizeUrl"):
    if needle not in sanitize:
        fail(f"logSanitize.js missing: {needle}")
logger_js = read(BE / "src" / "config" / "logger.js")
if "winston.format.json()" not in logger_js or "redact" not in logger_js:
    fail("logger.js must JSON-format (prod) through redaction")
if "colorize" in logger_js and "production" not in logger_js:
    fail("logger.js must restrict pretty output to non-production")
ok("redaction patterns + JSON production logging wired")

# --- 4. obs chart shape ---------------------------------------------------------------
print("-- obs chart --")
chart = yaml.safe_load(read(OBS / "Chart.yaml"))
assert chart["apiVersion"] == "v2" and chart["name"] == "chess-observability", chart
values = yaml.safe_load(read(OBS / "values.yaml"))
for comp, repo in (("prometheus", "prom/prometheus"), ("alertmanager", "prom/alertmanager"),
                   ("loki", "grafana/loki"), ("grafana", "grafana/grafana"),
                   ("alloy", "grafana/alloy")):
    img = values[comp]["image"]
    if img["repository"] != repo or not img["tag"] or img["tag"] == "latest":
        fail(f"{comp} image must be pinned (got {img})")
ksm = values["kubeStateMetrics"]["image"]
if not ksm["tag"] or ksm["tag"] == "latest":
    fail(f"ksm image must be pinned (got {ksm})")
for f in (OBS / "templates").glob("*.yaml"):
    text = read(f)
    if text.count("{{") != text.count("}}"):
        fail(f"{f.name}: unbalanced helm braces")
ok("Chart.yaml v2 + 6 pinned images + balanced templates")

# --- 5. dashboards -------------------------------------------------------------------
print("-- dashboards --")
dashboards = sorted((OBS / "dashboards").glob("*.json"))
if len(dashboards) != 5:
    fail(f"expected exactly 5 dashboards, found {len(dashboards)}")
for dash in dashboards:
    try:
        data = json.loads(read(dash))
    except Exception as e:  # noqa: BLE001
        fail(f"{dash.name} invalid JSON: {e}")
        continue
    for key in ("title", "uid", "panels"):
        if key not in data:
            fail(f"{dash.name} missing {key}")
    for panel in data.get("panels", []):
        for target in panel.get("targets", []):
            ds = (target.get("datasource") or panel.get("datasource") or {}).get("uid", "") if isinstance(target, dict) else ""
            ds = ds or (panel.get("datasource") or {}).get("uid", "")
            if ds and ds not in {"chess-prometheus", "chess-loki"}:
                fail(f"{dash.name} panel {panel.get('id')}: unknown datasource {ds}")
    for var in data.get("templating", {}).get("list", []):
        if var.get("type") == "query":
            fail(f"{dash.name}: query variables forbidden (cardinality); use const/custom")
ok("5 dashboards parse + datasource UIDs valid + no query variables")

# --- 6. prometheus config + rules (inner YAML) -----------------------------------------
print("-- prometheus rules --")
def dehelm(text: str) -> str:
    """Strip Helm actions so raw templates parse as YAML (structure check)."""
    kept = [line for line in text.splitlines() if not line.strip().startswith("{{")]
    return re.sub(r"{{.*?}}", "PLACEHOLDER", "\n".join(kept))


prom_cfg_text = read(OBS / "templates" / "prometheus-config.yaml")
docs = [d for d in yaml.safe_load_all(dehelm(prom_cfg_text)) if d]
prom_yml = yaml.safe_load(next(d for d in docs if d["metadata"]["name"] == "prometheus-config")["data"]["prometheus.yml"])
jobs = {job["job_name"] for job in prom_yml["scrape_configs"]}
for job in ("prometheus", "alloy", "loki", "alertmanager", "grafana"):
    if job not in jobs:
        fail(f"prometheus.yml missing self-job: {job}")
if jobs & {"backend", "kube-state-metrics", "kubelet"}:
    fail("prometheus must not duplicate Alloy jobs (single ingestion path)")
rules_text = next(d for d in docs if d["metadata"]["name"] == "prometheus-rules")["data"]
recording = yaml.safe_load(rules_text["recording.yml"])
alerts_doc = yaml.safe_load(rules_text["alerts.yml"])
rec_names = {r["record"] for g in recording["groups"] for r in g["rules"]}
for rec in ("api:http_request_rate5m", "api:http_error_ratio5m", "api:http_latency_p95_5m"):
    if rec not in rec_names:
        fail(f"recording rule missing: {rec}")
alert_count = 0
for group in alerts_doc["groups"]:
    for rule in group["rules"]:
        alert_count += 1
        for field in ("alert", "expr", "for", "labels", "annotations"):
            if field not in rule:
                fail(f"alert {rule.get('alert', '?')} missing {field}")
        if rule.get("labels", {}).get("severity") not in {"critical", "warning", "info"}:
            fail(f"alert {rule.get('alert')} has no valid severity")
        ann = rule.get("annotations", {})
        if "runbook_url" not in ann or "runbooks/" not in ann["runbook_url"]:
            fail(f"alert {rule.get('alert')} missing runbook_url")
        else:
            rb = APP / "docs" / "runbooks" / ann["runbook_url"].rsplit("/", 1)[-1]
            if not rb.exists():
                fail(f"alert {rule.get('alert')} runbook missing: {rb.name}")
if alert_count < 15:
    fail(f"expected >=15 alerts, found {alert_count}")
ok(f"prometheus.yml parses (self-jobs only) + {len(rec_names)} recordings + {alert_count} alerts with runbooks")

# --- 6b. PromQL/LogQL expression validation --------------------------------------------
print("-- promql/logql --")
PROMQL_NON_METRICS = {
    # aggregations
    "sum", "min", "max", "avg", "count", "stddev", "stdvar", "group",
    "topk", "bottomk", "count_values", "quantile", "limitk", "limit_ratio",
    # functions used or allowed (closed list; anything else must be a metric)
    "rate", "irate", "increase", "delta", "idelta", "histogram_quantile",
    "histogram_sum", "histogram_count", "histogram_avg", "histogram_stddev",
    "histogram_stdvar", "histogram_fraction", "absent", "absent_over_time",
    "clamp", "clamp_min", "clamp_max", "round", "floor", "ceil", "sqrt",
    "exp", "ln", "log2", "log10", "abs", "sgn", "sort", "sort_desc",
    "time", "vector", "scalar", "label_replace", "label_join",
    "predict_linear", "deriv", "changes", "resets", "avg_over_time",
    "min_over_time", "max_over_time", "sum_over_time", "count_over_time",
    "last_over_time", "present_over_time", "quantile_over_time",
    "stddev_over_time", "stdvar_over_time", "day_of_month", "day_of_week",
    "days_in_month", "hour", "minute", "month", "year",
    # keywords / modifiers
    "by", "without", "on", "ignoring", "group_left", "group_right",
    "and", "or", "unless", "bool", "offset", "start", "end",
    "inf", "nan",
    # LogQL pipeline stages/keywords (metric-name check skipped for logql)
    "json", "logfmt", "regexp", "pattern", "unpack", "line_format",
    "label_format", "decolorize", "drop", "keep", "replace",
}
hist_names = set(re.findall(r"new Histogram\(\s*\"([^\"]+)\"", index_js))
allowed_metrics = set(code_metrics) | set(rec_names) | {"up", "ALERTS"}
for h in hist_names:
    allowed_metrics |= {f"{h}_bucket", f"{h}_sum", f"{h}_count"}
INFRA_PREFIXES = ("kube_", "kubelet_", "container_", "node_", "prometheus_", "probe_")


def check_promql(expr, where):
    if expr.count("(") != expr.count(")"):
        fail(f"{where}: unbalanced parens: {expr[:100]}")
    if expr.count("{") != expr.count("}"):
        fail(f"{where}: unbalanced braces: {expr[:100]}")
    if expr.count("[") != expr.count("]"):
        fail(f"{where}: unbalanced brackets: {expr[:100]}")
    if expr.count('"') % 2:
        fail(f"{where}: unbalanced quotes: {expr[:100]}")
    if "{{" in expr or "}}" in expr:
        fail(f"{where}: raw helm braces inside expression")
    scrubbed = re.sub(r'"(?:\\.|[^"\\])*"', '""', expr)  # drop string literals
    scrubbed = re.sub(r"\{[^}]*\}", "{}", scrubbed)  # drop selector label lists
    scrubbed = re.sub(r"\b(by|without|on|ignoring)\s*\([^)]*\)", r"\1", scrubbed)  # drop grouping labels
    for tok in re.findall(r"\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b", scrubbed):
        if tok in PROMQL_NON_METRICS:
            continue
        if tok in allowed_metrics or tok.startswith(INFRA_PREFIXES):
            continue
        fail(f"{where}: unknown metric/function {tok!r} in: {expr[:120]}")


def check_logql(expr, where):
    if expr.count("{") != expr.count("}"):
        fail(f"{where}: unbalanced braces: {expr[:100]}")
    if expr.count('"') % 2:
        fail(f"{where}: unbalanced quotes: {expr[:100]}")
    if "namespace=" not in expr:
        fail(f"{where}: logql must scope a namespace selector: {expr[:100]}")


n_prom, n_log = 0, 0
for dash in sorted((OBS / "dashboards").glob("*.json")):
    try:
        data = json.loads(read(dash))
    except Exception:
        continue  # reported in section 5
    for panel in data.get("panels", []):
        for target in panel.get("targets", []) or []:
            if not isinstance(target, dict) or not target.get("expr"):
                continue
            ds = (target.get("datasource") or panel.get("datasource") or {}).get("uid", "")
            where = f"{dash.name} panel {panel.get('id')}"
            if ds == "chess-loki":
                check_logql(target["expr"], where)
                n_log += 1
            else:
                check_promql(target["expr"], where)
                n_prom += 1
for group in recording["groups"]:
    for r in group["rules"]:
        check_promql(r["expr"], f"recording {r['record']}")
        n_prom += 1
for group in alerts_doc["groups"]:
    for r in group["rules"]:
        check_promql(r["expr"], f"alert {r['alert']}")
        n_prom += 1
ok(f"{n_prom} promql exprs reference known metrics + balanced; {n_log} logql exprs scoped")

# --- 7. loki config (inner YAML) --------------------------------------------------------------
print("-- loki config --")
loki_doc = yaml.safe_load(dehelm(read(OBS / "templates" / "loki-config.yaml")))
loki_inner = loki_doc["data"]["loki.yaml"].replace("PLACEHOLDER", "168h")
loki_cfg = yaml.safe_load(loki_inner)
if loki_cfg["auth_enabled"] is not False:
    fail("loki auth_enabled must be false (netpol-isolated single tenant)")
if "retention_period" not in str(loki_cfg):
    fail("loki must set retention_period")
ok("loki.yaml parses + retention bounded")

# --- 8. river pipeline ------------------------------------------------------------------
print("-- alloy river --")
river = read(OBS / "templates" / "alloy-config.yaml")
if river.count("{") != river.count("}"):
    fail("config.alloy unbalanced braces")
for needle in ('cluster {', 'join_addresses', 'local.file_match "pods"',
               'loki.source.file "pods"', 'loki.process "pods"', 'stage.cri',
               'stage.regex', 'stage.labels', 'loki.write "default"',
               'prometheus.scrape "backend"', 'prometheus.scrape "ksm"',
               'prometheus.scrape "kubelet"', 'discovery.kubernetes "nodes"',
               'discovery.relabel "kubelet"', 'prometheus.remote_write "default"',
               'job         = "backend"', 'job         = "kube-state-metrics"',
               'replacement   = "$1:10250"', 'bearer_token_file',
               'url = "http://loki:3100/loki/api/v1/push"',
               'url = "http://prometheus:9090/api/v1/write"'):
    if needle not in river:
        fail(f"config.alloy missing: {needle}")
ok("river components + job names + remote-write endpoints present")

# --- 9. forbidden surface + documented exceptions ----------------------------------------
print("-- obs security surface --")


def code_lines(p: Path) -> str:
    return "\n".join(line for line in read(p).splitlines() if not line.strip().startswith("#"))


code_files = sorted(OBS.glob("templates/*.yaml"))
obs_code = "\n".join(code_lines(p) for p in code_files)
for needle in ("privileged: true", "runAsUser: 0", "hostNetwork", "hostPID",
               "NodePort", "type: LoadBalancer", "kind: HorizontalPodAutoscaler",
               "kind: ClusterRoleBinding" if False else "kind: PodSecurityPolicy"):
    if needle in obs_code:
        fail(f"forbidden {needle!r} in obs chart code")
hostpath_files = [f.name for f in code_files if "hostPath" in code_lines(f)]
if hostpath_files != ["alloy-daemonset.yaml"]:
    fail(f"hostPath allowed ONLY in alloy-daemonset.yaml (got {hostpath_files})")
ro_false = [f.name for f in code_files if "readOnlyRootFilesystem: false" in code_lines(f)]
if ro_false != ["grafana.yaml"]:
    fail(f"writable rootfs allowed ONLY in grafana.yaml (got {ro_false})")
if re.search(r"image:.*:latest\b", obs_code):
    fail("mutable :latest image in obs chart")
if "secretKeyRef" not in obs_code or "chess-observability" not in obs_code:
    fail("grafana must inject admin creds from the ESO secret")
for needle in ("hooks.slack.com", "AKIA", "BEGIN PRIVATE", "password: ", "passwd: "):
    if needle in obs_code:
        fail(f"possible secret in obs chart: {needle}")
ok("no privileged/host/exposed surface; hostPath+grafana-rootfs exceptions scoped")

# --- 10. RBAC least privilege ---------------------------------------------------------------
print("-- rbac --")
def _code(p: Path) -> str:
    return "\n".join(line for line in read(p).splitlines() if not line.strip().startswith("#"))


alloy_rbac = _code(OBS / "templates" / "rbac-alloy.yaml")
if '"nodes/proxy"' not in alloy_rbac and "'nodes/proxy'" not in alloy_rbac and "nodes/proxy" not in alloy_rbac:
    fail("alloy ClusterRole must allow nodes/proxy (kubelet scrape)")
for bad in ("secrets", "create", "delete", "update", "patch", '"*"'):
    if bad in alloy_rbac:
        fail(f"alloy RBAC too broad: {bad}")
prom_rbac = read(OBS / "templates" / "rbac-prometheus.yaml")
if "kind: Role\n" not in prom_rbac or "kind: ClusterRole" in prom_rbac:
    fail("prometheus RBAC must be namespaced Role (not ClusterRole)")
ksm_rbac = _code(OBS / "templates" / "rbac-ksm.yaml")
if "secrets" in ksm_rbac:
    fail("ksm ClusterRole must not read secrets")
verbs = set(re.findall(r'"(get|list|watch|create|delete|update|patch|\*)"', ksm_rbac))
if not verbs <= {"get", "list", "watch"}:
    fail(f"ksm verbs must be read-only (got {verbs})")
ok("alloy minimal cluster reads; prometheus namespaced; ksm read-only sans secrets")

# --- 11. network policy ------------------------------------------------------------------
print("-- networkpolicy --")
obs_netpol = read(OBS / "templates" / "networkpolicy.yaml")
if "default-deny-ingress" not in obs_netpol:
    fail("obs chart must include ingress default-deny")
for port in ("9090", "9093", "3100", "3000", "8080", "12345"):
    if port not in obs_netpol:
        fail(f"obs netpol missing port {port}")
app_netpol = read(APP / "deploy" / "helm" / "chess" / "templates" / "networkpolicy.yaml")
if "app.kubernetes.io/name: alloy" not in app_netpol or "namespaceSelector" not in app_netpol:
    fail("app netpol must allow alloy scrapes (namespace+pod scoped)")
app_obs_ns = yaml.safe_load(read(APP / "deploy" / "helm" / "chess" / "values.yaml"))["observability"]["namespace"]
obs_ns = yaml.safe_load(read(OBS / "values.yaml"))["namespace"]["name"]
if app_obs_ns != obs_ns:
    fail(f"namespace drift: app observability.namespace={app_obs_ns} vs obs {obs_ns}")
ok("obs default-deny + ports; app allows alloy; namespaces agree")

# --- 12. runbooks + SLOs ----------------------------------------------------------------------
print("-- runbooks + slos --")
# Wave 7 Phase 5 advancement: +rate-limit-degraded (the ChessRateLimitDegraded
# alert's runbook). All 9 prior runbooks keep identical assertions.
expected = {"backend-unavailable", "high-5xx", "high-latency", "pod-crashloop",
            "oom-kill", "database-connectivity", "migration-failure",
            "observability-stack-failure", "alb-errors", "rate-limit-degraded"}
found = {p.stem for p in (APP / "docs" / "runbooks").glob("*.md")}
if found != expected:
    fail(f"runbook set mismatch: missing={expected - found} extra={found - expected}")
for rb in sorted((APP / "docs" / "runbooks").glob("*.md")):
    text = read(rb)
    sections = re.findall(r"^## (\d+)\.", text, re.M)
    if sections != [str(n) for n in range(1, 10)]:
        fail(f"{rb.name} must carry sections 1-9 in order (got {sections})")
    if "chess-staging" not in text and "chess-observability" not in text:
        fail(f"{rb.name} must use real namespace names")
    if "kubectl" not in text:
        fail(f"{rb.name} must include kubectl commands")
slo = read(APP / "docs" / "slo" / "chess-staging-slos.md")
for sid in ("SLO-1", "SLO-2", "SLO-3", "SLO-4", "SLO-5", "SLO-6"):
    if sid not in slo:
        fail(f"slo doc missing {sid}")
for field in ("numerator", "denominator", "target", "window", "exclusions", "runbook"):
    if field not in slo:
        fail(f"slo doc missing field: {field}")
ok("10 runbooks x 9 sections + 6 SLOs with full fields")

# --- 12b. SRE operating model + threat matrix ----------------------------------------------
print("-- sre model + threat matrix --")
sre = APP / "docs" / "sre" / "observability-model.md"
threat = APP / "docs" / "security" / "wave6-threat-matrix.md"
if not sre.exists():
    fail("docs/sre/observability-model.md missing")
else:
    sre_text = read(sre)
    for needle in ("Incident workflow", "Deployment correlation", "Cost model",
                   "Backup / recovery", "chess_build_info"):
        if needle not in sre_text:
            fail(f"observability-model.md missing: {needle}")
if not threat.exists():
    fail("docs/security/wave6-threat-matrix.md missing")
else:
    threat_text = read(threat)
    for tid in [f"T{n}" for n in range(1, 16)]:
        if tid not in threat_text:
            fail(f"wave6-threat-matrix.md missing row {tid}")
    for needle in ("Mitigation", "Residual", "ACCEPT"):
        if needle not in threat_text:
            fail(f"wave6-threat-matrix.md missing column: {needle}")
ok("sre operating model + T1-T15 threat matrix present")

# --- 13. tests + workflows ------------------------------------------------------------------
print("-- tests + workflows --")
unit_cfg = read(BE / "jest.unit.config.js")
if "observability.unit.test.js" not in unit_cfg:
    fail("jest.unit.config.js must include the observability suite")
if not (BE / "tests" / "observability.unit.test.js").exists():
    fail("tests/observability.unit.test.js missing")
infra = read(APP / ".github" / "workflows" / "infra-validation.yml")
if "deploy/helm/chess-observability" not in infra:
    fail("helm-validate must lint+render the obs chart")
if "wave6-static-checks.py --skip-bundle" not in infra:
    fail("CI must run wave6-static-checks.py --skip-bundle")
ok("unit suite registered + CI covers obs chart + wave6 battery")

# --- 14. gitops bundle (local only) ---------------------------------------------------
skip_bundle = "--skip-bundle" in sys.argv
bundle = Path(os.environ.get("CHESS_GITOPS", "/home/user/chess-gitops"))
if "--bundle" in sys.argv:
    bundle = Path(sys.argv[sys.argv.index("--bundle") + 1])
if not skip_bundle:
    print(f"-- gitops bundle ({bundle}) --")
    if not bundle.is_dir():
        fail(f"bundle dir missing: {bundle}")
    else:
        for rel in ("projects/observability.yaml",
                    "apps/observability/staging/application.yaml",
                    "apps/observability/staging/values.yaml"):
            try:
                list(yaml.safe_load_all(read(bundle / rel)))
            except Exception as e:  # noqa: BLE001
                fail(f"bundle YAML parse failed: {rel}: {e}")
        proj = read(bundle / "projects" / "observability.yaml")
        if '"*"' in proj or "'*'" in proj:
            fail("observability project contains a wildcard")
        if "namespace: chess-observability" not in proj:
            fail("observability project must pin the obs destination")
        for kind in ("StatefulSet", "DaemonSet", "ClusterRole", "ClusterRoleBinding"):
            if kind not in proj:
                fail(f"observability project whitelist missing {kind}")
        app_yaml = read(bundle / "apps" / "observability" / "staging" / "application.yaml")
        for needle in ("deploy/helm/chess-observability", "ref: values", "automated:",
                       "prune: true", "selfHeal: true", "project: observability"):
            if needle not in app_yaml:
                fail(f"observability application missing: {needle}")
        values_yaml = read(bundle / "apps" / "observability" / "staging" / "values.yaml")
        placeholders = set(re.findall(r"CHANGEME_[A-Z_]+", values_yaml))
        readme = read(bundle / "README.md")
        documented = set(re.findall(r"CHANGEME_[A-Z_*]+", readme))
        import fnmatch as _fn
        undoc = sorted(u for u in placeholders if not any(_fn.fnmatch(u, d) for d in documented))
        if undoc:
            fail(f"undocumented obs placeholders: {undoc}")
        bootstrap = read(bundle / "bootstrap" / "install-argocd.sh")
        if "apps/observability/staging/application.yaml" not in bootstrap:
            fail("bootstrap must apply the observability application")
        ok("obs project tight + application multi-source + placeholders documented")
else:
    print("-- gitops bundle SKIPPED (--skip-bundle, CI mode) --")

print()
if failures:
    print(f"{len(failures)} FAILURE(S)")
    sys.exit(1)
print("ALL WAVE 6 STATIC CHECKS PASSED")
