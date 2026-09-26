# Wave 6 security baseline — observability + SRE foundation (staging)

Status: IMPLEMENTED + LOCALLY VALIDATED. Live AWS/EKS/ArgoCD proof is
USER-SIDE (no cluster, no Helm binary, no AWS credentials in this sandbox).
Nothing below is claimed from an unexecuted run.

Wave 6 builds the SRE foundation for staging ONLY: Alloy (one collector) →
Prometheus + Loki → Grafana, with Alertmanager routing, kube-state-metrics
object state, metrics-server via EKS add-on, 5 dashboards, 21 alerts, 6 SLOs,
9 runbooks. No production, no Wave 7 scale-out, no HPA.

## A. Pre-implementation audit (gaps found, all closed or documented)

| Area | Finding |
|---|---|
| Backend metrics | NO endpoint existed (`/metrics` absent, zero prom-client usage) → implemented zero-dependency exposition |
| Backend logging | winston JSON config overridden by pretty `colorize+simple` Console transport (non-JSON in prod) → fixed: JSON in prod/test |
| Redaction | NONE (morgan `combined` logs raw URLs; logger passes objects through) → implemented pre-serialization redaction + URL scrubbing |
| Correlation | NO `request_id` (ADR-009 requires emission) → added middleware + morgan token + error logs |
| Frontend | nginx default combined logs only; no metrics surface (correct for static) → documented, no change |
| Socket.io | connect/disconnect/auth events logged, uncounted → 6 metrics + hooks |
| DB | pool stats invisible, no query latency → gauges + verb-labeled histograms |
| TF | no metrics-server; ESO scope covered 2 secrets → add-on + 3rd secret |
| GitOps | no observability project/app → added (separate repo, same pattern) |
| Mail | already avoids logging recipients/links (good, kept) |
| Tokens in URLs | none (verify/reset are POST bodies) → morgan scrubbing is defense-in-depth |

## B. Architecture (ADR-009 honored)

```text
backend :5000/metrics ──┐
KSM :8080 ──────────────┤── Alloy (DaemonSet, clustered) ──remote-write──▶ Prometheus (15d, 10Gi)
kubelets :10250 ────────┘                                          ▲
/var/log/pods ── Alloy ──push──▶ Loki (7d, 5Gi) ◀── query ──┐ Grafana (ClusterIP, ESO admin)
                                                            └─ rules ─▶ Alertmanager ─▶ staging webhook (ESO)
Prometheus self-jobs (Alloy-independent): self, alloy, loki, alertmanager, grafana.
CloudWatch stays authoritative: EKS control-plane/audit, RDS, ALB, CloudTrail, VPC flow logs.
```

## C. Stack decision (no operator)

kube-prometheus-stack REJECTED (10 CRDs + webhooks + exporters for a 3-pod
app); bare Operator REJECTED (CRDs without payoff); standalone Prometheus +
Alloy + Loki + Grafana + Alertmanager + KSM CHOSEN (zero CRDs, fully
auditable, matches the Wave 5 authored-chart + CI lint/template/kubeconform
pattern). Revisit at production scale (Wave 8) with measured need.

## D. Components (namespace `chess-observability`, all pinned 2026-09-22)

| Component | Kind | Version | Storage | Notes |
|---|---|---|---|---|
| Prometheus | StatefulSet 1× | v3.14.0 | 10Gi RWO | remote-write receiver ON; 30s scrape/eval |
| Alertmanager | Deployment 1× | v0.34.1 | 64Mi emptyDir | ESO-templated config; silences ephemeral |
| Loki | StatefulSet 1× | 3.7.8 | 5Gi RWO | TSDB filesystem; compactor expiry 168h |
| Grafana | Deployment 1× | 13.2.2 | 2Gi RWO | sqlite; provisioned datasources + 5 dashboards; zero plugins |
| Alloy | DaemonSet | v1.19.2 | — | logs + clustered metrics; gossip via headless svc |
| kube-state-metrics | Deployment 1× | v2.20.0 | — | scraped by Alloy ONLY |
| metrics-server | EKS add-on | most_recent | — | `kubectl top` + HPA-prereq API; NOT a Prometheus source |

Images are TAG-pinned (registry-blind sandbox cannot resolve digests);
USER-SIDE digest resolution command lives in the chart README, and
`obs.image` prefers digests the moment they are set.

## E. Application metrics (17, catalog: docs/observability/telemetry-catalog.md)

HTTP (count/duration/in-flight/size, labels method×route-pattern×class),
`app_errors_total{component}`, uptime, event-loop lag, pool gauges,
query latency/errors by SQL verb (15+OTHER), 6 Socket.io series, build info.
Cardinality is enforced in CODE (fixed label sets, reserved PII names throw,
128-char cap, routes are patterns, 404s collapse). `/metrics` is same-port,
scrape-excluded, un-rate-limited, netpol-restricted, and CANNOT affect
liveness (separate handler, try/catch, zero shared state).

## F. Logging + redaction

JSON to stdout in prod/test (pretty dev only); every object passes redaction
BEFORE serialization (sensitive keys, DB URLs, AKIA, JWTs, Slack tokens);
morgan URLs scrubbed (query keys + JWT segments); `request_id` per request
(ADR-009) + `traceparent` propagated (never generated — no SDK yet). Loki
labels: cluster/namespace/pod/container ONLY (15-name cap); IDs live in
bodies. Full field tables + budgets: telemetry-catalog.md.

## G. Alerting (21 alerts, 4 groups + SLO burn pair)

Availability (backend/frontend down, 5xx, latency, fast/slow burn),
workloads (crashloop, restarts, OOM, unavailable, CPU/mem saturation,
migration failed), dependencies (pool exhaustion, DB errors, socket auth
flood), observability (Alloy/Loki/AM down, pipeline stale, obs exhaustion).
Every alert: severity + `for` + summary/description + `runbook_url` (all 9
runbooks exist; static-checked). Critical pages staging webhook; warning is
same-day Grafana work; nothing routes to production channels (no prod
receiver exists). RDS/ALB/cert stay CloudWatch-native (documented alarms as
USER-SIDE commands, never fabricated Prometheus metrics).

## H. SLOs + error budgets (docs/slo/chess-staging-slos.md)

6 proposed objectives (availability 99%, latency p95<1.5s, 5xx paging lens,
Socket.io 99%, deploy success ≥95% manual count — honest gap, DB 99.5%),
each with service/indicator/numerator/denominator/target/window/exclusions/
alert/runbook/owner. Budgets drive release freezes (<25% remaining), not
scores. First 30 days calibrate; nothing claims measured compliance.

## I. Dashboards (5, provisioned, UI edits reset on resync)

Platform Overview (11 panels), Backend/API (8), Kubernetes/Workloads (8),
Database/RDS (5, incl. CloudWatch truth panel), Logs/Errors (5 LogQL).
Fixed datasource UIDs, zero query variables (cardinality-safe).

## J. Runbooks (9 × 9 sections, real resource names)

backend-unavailable, high-5xx, high-latency, pod-crashloop, oom-kill,
database-connectivity, migration-failure, observability-stack-failure
(incl. Alloy FALLBACK: disable Alloy metrics → enable commented Prometheus
jobs), alb-errors (CloudWatch-native with exact CLI). Each: symptoms,
first checks, queries, kubectl, logs, causes, remediation,
rollback/escalation, data/security cautions.

## K. Kubernetes events (§21)

No event exporter (retention discipline: events are inspectional, not
persisted). Operator path (documented in every runbook §4):
`kubectl get events --sort-by=.lastTimestamp`, plus
FailedScheduling/FailedMount/BackOff/ImagePullBackOff/readiness/OOMKilled
via `describe` + waiting/terminated reason metrics. Eventrouter-style
persistence is a Wave 8 option, not a Wave 6 gap.

## L. Network policy review (connectivity preserved)

Obs: ingress default-deny + same-ns pod traffic per-port (9090/9093/3100/
3000/8080/12345 incl. gossip) + node CIDRs (kubelet + port-forward). App:
ADDED Alloy→backend:5000 (namespace AND pod scoped); frontend/backend/
migration/DNS/ALB/RDS/ESO paths UNCHANGED (Wave 5 battery still green).
Egress stays open both namespaces (Wave 5 rationale: no FQDN engine).
Nothing breaks: DNS (egress), ALB (frontend rule), RDS (egress + SG),
ESO (egress), ArgoCD (separate ns, untouched).

## M. Secrets (zero new plaintext)

Grafana admin + alert webhook live in `chess/staging/observability`
(Secrets Manager) → ESO (`chess-observability` + ESO-templated
`alertmanager.yml`) → env/volume. IRSA scope grew by exactly one named
secret. GitOps values carry NO secrets (node CIDRs only). Greps: no
AKIA/private-key/password/webhook values in either repo (§O).

## N. Retention + resources (bounded staging)

Prometheus 15d/10Gi, Loki 7d/5Gi + 8MB/s ingestion cap, Grafana sqlite 2Gi,
AM silences ephemeral, CloudWatch per Wave 4. Every workload has
requests+limits (sizing table in chart values; obs total ≈ 0.8cpu/1Gi req —
cannot starve the app). StorageClasses encrypted gp3, WFFC, expansion on,
Delete reclaim (telemetry is disposable; systems of record are git + RDS).

## O. Security controls + exceptions (all documented)

Non-root + RuntimeDefault + drop ALL + no-privilege-escalation everywhere;
dedicated SAs (tokens only where the K8s API is called); least-privilege
RBAC (Alloy: nodes + nodes/proxy reads; Prometheus: namespaced pod reads;
KSM: read-only, no secrets); ClusterIP/headless only (zero ingress for obs);
Kyverno-audit compatible (container-level flags; tag-pinned images will
REPORT on policy 05 until digests land — audit, not block). EXCEPTIONS:
(1) Alloy `/var/log` hostPath RO (log files + symlink resolution);
(2) Grafana writable rootfs (sqlite/provisioning; UID 472 + drop ALL +
netpol mitigate). Both static-checked as the ONLY occurrences.

## P. Validation ledger

VALIDATED: wave6 battery ALL PASS (14 sections incl. bundle); wave5 battery
(still green); TF static (green); backend unit 28/28 (17 old + 11 new);
dashboards JSON (5/5); rules/loki YAML inner-parse; River component audit;
RBAC verb audit; §26-style greps (zero unexplained — §Q). NOT RUN —
ENVIRONMENT LIMITATION: helm lint/template + kubeconform (binaries
unfetchable; blocking CI covers), promtool (rule syntax validated by YAML
parse + review; USER-SIDE `promtool check rules`), live ArgoCD sync,
Alloy clustering dedup (`count by (job)(up)` = 1), ESO sync, Grafana login,
Alertmanager delivery (USER-SIDE: test alert → webhook), TF plan/apply,
`kubectl top`.

## Q. Security greps (2026-09-22, per-hit justification)

`privileged: true`, `runAsUser: 0`, `hostNetwork|hostPID`, `NodePort|LoadBalancer`,
`:latest`, `HorizontalPodAutoscaler`, `AKIA|BEGIN PRIVATE|hooks.slack.com`,
`password: |passwd: ` — ZERO in obs chart + bundle. `hostPath` — 1 file
(alloy-daemonset, §O exception). `readOnlyRootFilesystem: false` — 1 file
(grafana, §O exception). `ClusterRole|ClusterRoleBinding` in obs project —
whitelist STRINGS (permission bounds, not grants). `redis|REDIS` — zero new
(this wave adds no Wave 7 tech). `GITHUB_TOKEN` in workflows — unchanged
(commit-back still scoped PAT).

## R. Wave 7/8 hand-off (prereqs, not scope)

- Wave 7 (scale-out): needs NOTHING reverted — backend metrics are
  replica-agnostic by design EXCEPT gauges sampled per-pod (`socket_io_*_active`,
  pool, in-flight sum across pods — dashboards must `sum()` after scale-out;
  noted in catalog). HPA itself will consume metrics-server (now present).
- Wave 8 (production hardening): Loki S3 + RF=3, Prometheus HA/thanos,
  Grafana Postgres + OIDC, KMS-grant scoping, digest pins, Kyverno enforce,
  ArgoCD notifications for SLO-5 automation, promtool in CI, CloudWatch alarm
  TF module (RDS/ALB/cert snippets live in runbooks as the starting spec).

## S. Residual risks (accepted for staging)

1. Tag-pinned (not digest-pinned) obs images — accepted; resolution path documented, Kyverno audits.
2. Single-replica Prometheus/Loki/Grafana/AM (no HA) — accepted; staging RPO/RTO need no HA.
3. Alloy clustering unverified blind — accepted; dedup query + FALLBACK documented and runbooked.
4. Loki filesystem (not S3) — accepted; Wave 8 owns production storage.
5. RDS/ALB/cert alerts are CloudWatch-manual, not Prometheus — accepted; runbooks carry exact commands.
6. No measured SLO history — accepted; objectives + burn alerts are live from first sync.
