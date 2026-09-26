# Runbook: migration failure (ChessMigrationFailed)

## 1. Symptoms

- Critical `ChessMigrationFailed`: Job `chess-migration` in `chess-staging` has failed completions.
- ArgoCD sync stuck at PreSync (new app version did NOT deploy — ordering held, this is the system working).

## 2. First checks

1. WHICH migration failed? (Job logs name the file + statement.)
2. Did it fail or is it still retrying? (`backoffLimit 3`, deadline 600s — check completions/active.)

## 3. Prometheus/Grafana queries

```promql
kube_job_status_failed{namespace="chess-staging",job_name="chess-migration"}
kube_job_status_active{namespace="chess-staging",job_name="chess-migration"}
kube_pod_container_status_waiting_reason{namespace="chess-staging",pod=~"chess-migration.*"}
```

Dashboard: Kubernetes / Workloads (Failed jobs stat).

## 4. kubectl commands

```bash
kubectl -n chess-staging get job chess-migration
kubectl -n chess-staging logs job/chess-migration --tail=150
kubectl -n chess-staging describe job chess-migration | tail -25
kubectl -n chess-staging get events --sort-by=.lastTimestamp | tail -15
```

## 5. Logs to inspect (Loki + Job logs)

- Job logs FIRST (authoritative): checksum mismatches, SQL errors, lock waits, `chess_user` missing (008 fail-closed).
- Loki `{namespace="chess-staging",container="migration"}` for history after the Job is cleaned up.

## 6. Likely causes

1. `chess_user` role missing (008 fails closed by design) — L.3 step skipped on a fresh database.
2. Checksum drift: a migration file changed after being applied (run.js refuses — DO NOT force).
3. SQL error in a NEW migration (syntax, missing table, lock timeout vs live traffic).
4. Master secret wrong/unreachable (ESO `chess-db-master` not synced).
5. Previous failed Job still present blocking re-sync (same name).

## 7. Safe remediation

- Missing role: create it per Wave 5 runbook L.3, delete the failed Job (`kubectl -n chess-staging delete job chess-migration`), re-sync in ArgoCD.
- Bad NEW migration: fix FORWARD (new commit amending the migration file ONLY if never applied anywhere; if applied anywhere, write a NEW fix migration), delete failed Job, re-sync.
- Stuck lock: confirm no migration pod is running before deleting the Job (two runners = the advisory lock's exact fear; the lock normally prevents this).
- NEVER edit `schema_migrations` rows by hand; NEVER mark a failed migration "done" manually.

## 8. Rollback/escalation

- DB rollback does not exist (forward-only). App rollback is irrelevant (new version never deployed).
- Escalate: lock held with no live pod, or repeated failures after a forward fix → platform page with full Job logs + `schema_migrations` table dump (filenames + checksums only, read-only query).

## 9. Data/security cautions

- Migration logs may contain DDL with table shapes — internal, fine for tickets; never include row data.
- Master credentials are in play: use the Job's mounted secret only, never export or print it.
