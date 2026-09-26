#!/usr/bin/env bash
# Wave 3 — build machine-readable release metadata for ONE image.
# Used by .github/workflows/release.yml; also runnable locally for testing.
# Emits JSON to stdout (redirect to release-metadata-<name>.json in CI).
# Never accepts secrets: all inputs are identifiers, digests, counts, file paths.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: make-metadata.sh \
  --name chess-backend --registry 123456789012.dkr.ecr.us-east-1.amazonaws.com \
  --tag sha-abcdef123456 --digest sha256:... --commit <full-sha> \
  --repo MomenLotfy/repo --run-id 123 --run-attempt 1 \
  --sbom sbom.spdx.json --trivy-critical 0 --trivy-high 0 \
  --cosign-identity "https://github.com/org/repo/.github/workflows/release.yml@refs/heads/main"
EOF
  exit 1
}

name=""; registry=""; tag=""; digest=""; commit=""; repo=""; run_id=""
run_attempt=""; sbom=""; critical=""; high=""; identity=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) name=$2; shift 2;;
    --registry) registry=$2; shift 2;;
    --tag) tag=$2; shift 2;;
    --digest) digest=$2; shift 2;;
    --commit) commit=$2; shift 2;;
    --repo) repo=$2; shift 2;;
    --run-id) run_id=$2; shift 2;;
    --run-attempt) run_attempt=$2; shift 2;;
    --sbom) sbom=$2; shift 2;;
    --trivy-critical) critical=$2; shift 2;;
    --trivy-high) high=$2; shift 2;;
    --cosign-identity) identity=$2; shift 2;;
    *) usage;;
  esac
done
[[ -n "$name" && -n "$registry" && -n "$tag" && -n "$digest" && -n "$commit" ]] || usage
[[ -n "$repo" && -n "$run_id" && -n "$run_attempt" && -n "$sbom" ]] || usage
[[ -n "$critical" && -n "$high" && -n "$identity" ]] || usage
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Invalid digest: $digest" >&2; exit 1; }
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid commit SHA: $commit" >&2; exit 1; }
[[ -f "$sbom" ]] || { echo "SBOM file not found: $sbom" >&2; exit 1; }
sbom_sha="$(sha256sum "$sbom" | awk '{print $1}')"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - "$name" "$registry" "$tag" "$digest" "$commit" "$repo" "$run_id" \
  "$run_attempt" "$sbom" "$sbom_sha" "$critical" "$high" "$identity" "$stamp" <<'EOF'
import json, sys
(name, registry, tag, digest, commit, repo, run_id, run_attempt,
 sbom, sbom_sha, critical, high, identity, stamp) = sys.argv[1:]
print(json.dumps({
    "schema": "chess-release-metadata/v1",
    "name": name,
    "source": {"repository": repo, "commit": commit},
    "build": {"timestamp": stamp, "workflow_run_id": run_id, "run_attempt": run_attempt},
    "image": {"registry": registry, "repository": name, "tag": tag, "digest": digest,
              "reference": f"{registry}/{name}@{digest}"},
    "sbom": {"format": "spdx-json", "file": sbom, "sha256": sbom_sha},
    "scan": {"scanner": "trivy-image", "critical": int(critical), "high": int(high),
             "policy": "block on HIGH,CRITICAL"},
    "signature": {"tool": "cosign-keyless", "identity": identity, "status": "signed"},
}, indent=2))
EOF
