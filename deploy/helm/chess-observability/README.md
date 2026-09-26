# chess-observability (Wave 6) — staging SRE stack

Standalone, operator-free observability: **Alloy** (one collector) →
**Prometheus** + **Loki** → **Grafana**, with **Alertmanager** routing and
**kube-state-metrics** for object state. No prometheus-operator, no CRDs, no
second agent.

## Why no operator (stack decision, §4)

| Option | Verdict |
|---|---|
| kube-prometheus-stack | REJECTED for staging: ~10 CRDs + admission webhooks + node-exporter + kube-proxy exporters for a 3-pod app; upgrade/complexity burden unjustified. |
| Prometheus Operator alone | REJECTED: Operator without the stack still needs ServiceMonitors + hand-rolled everything else — CRDs without payoff. |
| Standalone Prometheus + Alloy + friends (CHOSEN) | Minimal, fully auditable, zero CRDs (AppProject whitelist stays tight), matches the Wave 5 authored-chart pattern (CI lint/template/kubeconform). |

Revisit for production scale (Wave 8): operator + Thanos/Cortex only with a
measured need.

## Architecture

```text
chess-backend :5000/metrics ──┐
KSM :8080 ────────────────────┤── Alloy (DaemonSet, clustered) ──remote-write──▶ Prometheus :9090 ──┐
kubelets :10250 ──────────────┘                                          ▲                           │ query
/var/log/pods (node-local) ── Alloy ──push──▶ Loki :3100 ◀──────────────┤ Grafana :3000              │
                                                                        └─ rules ─▶ Alertmanager ────┘
Prometheus self-jobs (pipeline health, Alloy-independent): self, alloy, loki, alertmanager, grafana.
```

- metrics-server is NOT in this chart: EKS managed add-on (Terraform).
- CloudWatch stays authoritative for EKS control-plane/audit, RDS, ALB,
  CloudTrail, VPC flow logs (Wave 4). Prometheus never scrapes RDS.

## Retention + storage (staging, bounded)

| Store | Retention | Size | Backend | Notes |
|---|---|---|---|---|
| Prometheus | 15d | 10Gi gp3 encrypted | StatefulSet RWO | 30s scrape; ~2 pods/node scale = ample headroom |
| Loki | 168h (7d) | 5Gi gp3 encrypted | StatefulSet RWO, TSDB | compactor expiry; 8MB/s ingestion cap |
| Grafana | n/a (sqlite) | 2Gi gp3 encrypted | Deployment RWO | dashboards provisioned; UI edits reset on resync |
| Alertmanager | silences ephemeral | 64Mi emptyDir | — | restarts drop silences (accepted, staging) |
| CloudWatch | per Wave 4 (30d cluster logs etc.) | AWS-managed | — | unchanged |

## Loki storage (staging vs production, §12)

Staging uses filesystem TSDB on EBS (explicit, encrypted, bounded). This is
NOT production architecture: production Loki needs S3 object storage +
RF=3 + separate compactor/ruler (Wave 8 requirement). This S3 is LOKI
storage and has NOTHING to do with Wave 7's application avatar-upload S3
migration — different buckets, different owners, different waves.

## Versions (pinned, verified 2026-09-22)

Prometheus v3.14.0, Alertmanager v0.34.1, Loki 3.7.8, Grafana 13.2.2,
Alloy v1.19.2, kube-state-metrics v2.20.0, metrics-server via EKS add-on
(most_recent, like Wave 5 add-ons).

Images are TAG-pinned (digests unresolvable from a registry-blind sandbox).
USER-SIDE (one-time, then set `*.image.digest` in gitops values):

```bash
for img in prom/prometheus:v3.14.0 prom/alertmanager:v0.34.1 grafana/loki:3.7.8 \
           grafana/grafana:13.2.2 grafana/alloy:v1.19.2 \
           registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.20.0; do
  echo "$img $(crane digest "$img" 2>/dev/null || docker buildx imagetools inspect "$img" --format '{{`{{json .Manifest.digest}}`}}')"
done
```

## Alloy clustering + FALLBACK

Metrics scrapes are clustered (`clustering.enabled`, gossip via the
alloy-gossip headless Service). Verify user-side (expect exactly 1 per job):

```promql
count by (job) (up{job=~"backend|kube-state-metrics|kubelet"})
```

If a job shows N>1 (clustering failed): disable Alloy metrics (comment the
three `prometheus.scrape` blocks + keep logs), uncomment the FALLBACK jobs in
prometheus.yml, resync. Detection + steps are also in
docs/runbooks/observability-stack-failure.md.

## Alloy UID / probes (blind-spot fallbacks)

- Alloy runs as its image-default non-root user (no UID pinning on purpose;
  KSM policy 02 needs only the `runAsNonRoot` flag). USER-SIDE: confirm
  `kubectl exec` shows non-root; if the image ever ships root, pin the UID.
- Probes use `/-/healthy` + `/-/ready`. If a future Alloy renames them,
  switch to `tcpSocket: {port: http}` (documented here so the fix is a
  one-line revert, not a redesign).

## Grafana access (internal only)

No ingress exists for Grafana/Prometheus/Loki/Alertmanager and none may be
added without auth + HTTPS + explicit domain review. Admin path:

```bash
kubectl -n chess-observability port-forward svc/grafana 3000:3000
kubectl -n chess-observability get secret chess-observability \
  -o jsonpath='{.data.grafana-admin-password}' | base64 -d; echo
```

datasources (Prometheus, Loki) and all 5 dashboards are provisioned; UI
changes reset on resync (`allowUiUpdates: false`).

## Labels + cardinality budget

- App metrics: fixed label sets, identity/PII label NAMES rejected at
  creation (registry.js), values capped at 128 chars. Routes are Express
  patterns (`/api/game/:id`), never raw paths.
- Loki labels: cluster/namespace/pod/container only (15-name cap enforced).
  No user/game/request IDs in labels — they live in log BODIES (JSON fields)
  where cardinality is free.
