# Runbook: OOM kill (ChessContainerOOMKilled / ChessMemorySaturation)

## 1. Symptoms

- Critical `ChessContainerOOMKilled`: last termination reason OOMKilled.
- Warning `ChessMemorySaturation` usually fires first (working set >90% of limit for 15m).

## 2. First checks

1. Which container? (backend 768Mi vs frontend 256Mi vs obs components.)
2. Growth (leak) or spike (traffic/deploy)? Check the memory panel slope.

## 3. Prometheus/Grafana queries

```promql
kube_pod_container_status_last_terminated_reason{reason="OOMKilled",namespace=~"chess-.*"}
sum by (pod) (container_memory_working_set_bytes{namespace=~"chess-.*",container!=""})
sum by (pod) (kube_pod_container_resource_limits{namespace=~"chess-.*",resource="memory"})
```

Dashboard: Kubernetes / Workloads (memory vs limits), Platform Overview (restarts).

## 4. kubectl commands

```bash
kubectl -n chess-staging describe pod -l app.kubernetes.io/name=backend | grep -B2 -A8 "Last State"
kubectl -n chess-staging top pod -l app.kubernetes.io/name=backend
kubectl -n chess-staging logs deploy/chess-backend -p --tail=40   # abrupt end, no shutdown line
```

## 5. Logs to inspect

- Previous logs typically END ABRUPTLY (kernel kill, no app shutdown line) — absence of "Shutdown complete" confirms OOM vs clean exit.
- Pre-OOM minute in Loki: GC pressure, large-payload warnings, room-count growth (`socket_io_rooms_active`).

## 6. Likely causes

1. Genuine leak: rooms/sockets/scores accumulating (rooms gauge never drops).
2. Spike: large avatar uploads, tournament fan-out, traffic burst on 768Mi backend.
3. Limit too tight for the workload (frontend 256Mi with big static assets? unlikely — frontend is nginx).
4. Node memory pressure evicting (check node status + other pods on the node).

## 7. Safe remediation

- Spike + healthy slope: raise the limit via chart values (reviewed commit), watch for 24h.
- Leak suspicion: DO NOT just raise limits — capture heap trajectory (memory panel 7d), file a bug with the growth rate, then raise temporarily to stabilize.
- Restart is automatic (kubelet recreates); manual `delete pod` only to force a clean slate after a fix.

## 8. Rollback/escalation

- OOM from a new release (regression): digest revert.
- Escalate: repeated OOM within an hour of a limit raise → platform page (probable leak; include 7d memory graph + rooms/sockets gauges).

## 9. Data/security cautions

- Heap dumps contain user data — never capture full dumps to shared storage without approval; graphs first.
- Backend OOM drops all live games (in-memory rooms); they rebuild from DB on boot — verify `rebuildActiveRooms` log line after recovery.
