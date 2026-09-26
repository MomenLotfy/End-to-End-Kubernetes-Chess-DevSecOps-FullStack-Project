# Wave 6 DevSecOps threat matrix — observability attack surface

Scope: everything Wave 6 added (backend telemetry endpoints + log pipeline,
`chess-observability` chart, Grafana dashboards/rules, webhook receiver,
docs). Threats to the Wave 5 app/data plane are covered by Wave 5 and
referenced, not repeated.

Likelihood/Impact: L/M/H. Residual: ACCEPT (staging) or MITIGATE (built in).

| # | Threat | Attack path | Mitigation (built, this wave) | L | I | Residual |
|---|---|---|---|---|---|---|
| T1 | Scrape of `/metrics` exposes internals | unauthenticated pod-port access to cardinality/user data | `/metrics`: localhost/Prometheus-only guidance, proves no PII/secret/identity labels; unit-tested reserved-label reject; no query params read | L | M | ACCEPT (staging; prod: auth) |
| T2 | Secret/token exfil via logs | JWT/DB creds printed by backend or shipped by Alloy | pre-serialization structured redaction + morgan URL scrub + Alloy drop-stage for `password\|secret\|token`; grep CI guard; redaction unit tests | L | H | ACCEPT (staging; quarterly keyword review) |
| T3 | PII in labels/log fields | user/game/socket IDs become label values | fixed bounded label sets; identity allowlists reject; Socket.io reason/verb allowlists; raw SQL never logged; static-check assertion | L | H | ACCEPT |
| T4 | High-cardinality DoS via crafted routes | unbounded route/method values fill TSDB | bounded ROUTE_PATTERN allowlist → `other`; method truncated; status bucketed; scrape 30s | L | M | ACCEPT |
| T5 | Alert fatigue / missed pages | noisy or misrouted alerts | 14 alerts with `for:` windows; single staging webhook; no prod receiver; runbook_url on every alert; weekly drill | M | M | ACCEPT (staging volume only) |
| T6 | Grafana takeover | default/weak admin creds, public exposure | ClusterIP-only; admin creds from Secrets Manager via ESO; random `secret_key`; no dashboards writable ad-hoc (provisioned) | L | H | ACCEPT (staging; prod: OAuth/OIDC) |
| T7 | Alertmanager webhook abuse | attacker triggers floods / learns topology | receiver URL in Secrets Manager, never in values/docs; `send_resolved:false`; single webhook; generic receiver naming | L | M | ACCEPT |
| T8 | Prometheus rule/config injection | malicious recording/alert YAML | rules baked in chart, no `additionalPrometheusRules`, checksum annotations, chart hash-pinned container digests | L | M | ACCEPT |
| T9 | Log injection → Loki forgery | CRLF in user strings forges log lines | JSON prod logs escape control chars; Alloy `(?s)` patterns on structured fields only | L | L | ACCEPT |
| T10 | Telemetry outage blinds detection | obs stack down hides app incident | `PrometheusTargetDown` self-watch; app probes independent of telemetry; documented blind-window incident rule | M | M | ACCEPT (staging single-copy; prod: HA in Wave 8) |
| T11 | metrics-server abuse / HPA misuse | unauth HPA pivot, over-scrape cluster | metrics-server minimal lease/election RBAC, no HPA objects, chart forbids HPA; KSM read-only ClusterRole, no secrets | L | M | ACCEPT |
| T12 | Dashboard XSS via annotations | malicious annotation/datasource HTML | 5 fixed dashboards, no external plugins, no anonymous auth, CSP-ready static frontend CSP headers (Wave 5) | L | M | ACCEPT |
| T13 | Retention/disk exhaustion | TSDB fills node disk | bounded retention (15d/7d) + PVC size caps + K8s `DiskPressure` sizing; Loki ingest caps | L | M | ACCEPT |
| T14 | Supply-chain: obs images | compromised Prometheus/Loki/Grafana image | all container images digest-pinned in values; cosign verification documented user-side | L | H | USER-SIDE (verify digests) |
| T15 | Webhook secret leak in git | receiver URL committed to repo/gitops | Secret pulled via ESO ExternalSecret only; `.gitignore` + grep guards for URLs in values/templates/docs | L | H | ACCEPT |

Deliberately OUT of Wave 6 (deferred with reason): prod alerting channels
(Wave 8), Grafana SSO (Wave 8), metrics authentication (Wave 8), Loki S3
backend with SSE (Wave 8), cross-region telemetry replication (not planned
for staging), WAF in front of ALB (Wave 7 hardening decision).
