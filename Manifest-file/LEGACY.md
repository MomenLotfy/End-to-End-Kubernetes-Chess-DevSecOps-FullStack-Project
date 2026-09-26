# LEGACY / NON-AUTHORITATIVE — do not use for new work

This directory (`Manifest-file/`) holds the pre-Wave-5 hand-written Kubernetes
manifests (frontend/backend/postgres/infrastructure). It is kept for reference
only until the GitOps path (Wave 5) is proven, then archived.

- K8s delivery authority is the Helm chart (Wave 5): `deploy/helm/chess/`
- Environment authority is the SEPARATE gitops repo (Wave 5): `chess-gitops`
  (ArgoCD Application `chess-staging` + images/wiring values)
- Database authority is RDS via the migration Job (Waves 4/5): in-cluster
  postgres (`deployment-postgres.yml`) is superseded and must NOT be applied
- These files are EXCLUDED from CI deploy paths; nothing may `kubectl apply`
  them (CI deploys nothing — delivery is ArgoCD-from-gitops only)

Do not extend this directory.
