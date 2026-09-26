#!/usr/bin/env bash
# Wave 3 — USER-SIDE AWS setup for the chess ECR release pipeline.
# Creates (idempotently): GitHub OIDC provider (if missing), the least-privilege
# release role + trust/permissions policies, and the 3 ECR repositories with
# scan-on-push, AES256 encryption, and the lifecycle policy.
#
# Prerequisites: AWS CLI v2 with an ADMIN-capable profile (only for this setup —
# the GitHub role itself gets ECR-push-only). No secrets are created or printed.
#
# Usage:
#   AWS_REGION=us-east-1 AWS_PROFILE=admin ./release/setup.sh
#
# After success, configure the GitHub repository VARIABLES (Settings → Variables):
#   AWS_RELEASE_ROLE_ARN = <printed role ARN>
#   AWS_REGION           = us-east-1   (must match the region used here)
# and create the `production` GitHub Environment (deployment branches: main only).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ROLE_NAME="${ROLE_NAME:-chess-ecr-release}"
POLICY_NAME="${POLICY_NAME:-chess-ecr-release-push}"
OIDC_URL="token.actions.githubusercontent.com"
REPOS="chess-backend chess-frontend chess-migration"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }; }
need aws
need openssl
need python3

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "$REGION")"
[[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || { echo "Cannot determine AWS account ID" >&2; exit 1; }
echo "Account: $ACCOUNT_ID  Region: $REGION  Role: $ROLE_NAME"

# --- 1. OIDC provider (reuse if present) ---
if aws iam list-open-id-connect-providers --query \
  "OpenIDConnectProviderList[?contains(Arn, '$OIDC_URL')].Arn" --output text | grep -q .; then
  echo "OIDC provider already exists, reusing it."
else
  echo "Creating OIDC provider for $OIDC_URL ..."
  # Thumbprint = SHA-1 of the ROOT CA (last cert in the verified chain), per:
  # https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create-oidc.html
  thumbprint="$(python3 - "$OIDC_URL" <<'EOF'
import socket, ssl, sys
host = sys.argv[1]
if not hasattr(ssl.SSLSocket, "get_verified_chain"):
    sys.exit("ERROR: Python 3.10+ required to derive the OIDC thumbprint")
ctx = ssl.create_default_context()
with ctx.wrap_socket(socket.socket(), server_hostname=host) as s:
    s.connect((host, 443))
    root = s.get_verified_chain()[-1]
print(root.digest("sha1").decode().replace(":", "").lower())
EOF
)"
  [[ "$thumbprint" =~ ^[0-9a-f]{40}$ ]] || { echo "Thumbprint derivation failed" >&2; exit 1; }
  aws iam create-open-id-connect-provider \
    --url "https://$OIDC_URL" \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list "$thumbprint"
fi

# --- 2. Release role + policies ---
trust_doc="$(mktemp)"; perm_doc="$(mktemp)"
trap 'rm -f "$trust_doc" "$perm_doc"' EXIT
sed "s/__AWS_ACCOUNT_ID__/$ACCOUNT_ID/g" "$SCRIPT_DIR/iam-trust-policy.json" > "$trust_doc"
sed -e "s/__AWS_ACCOUNT_ID__/$ACCOUNT_ID/g" -e "s/__AWS_REGION__/$REGION/g" \
  "$SCRIPT_DIR/iam-permissions-policy.json" > "$perm_doc"
python3 -c "import json; json.load(open('$trust_doc')); json.load(open('$perm_doc')); print('policy JSON valid')"

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Role $ROLE_NAME exists, updating trust policy."
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://$trust_doc"
else
  echo "Creating role $ROLE_NAME ..."
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$trust_doc" \
    --description "Wave 3: GitHub OIDC ECR push-only release role (chess)" \
    --tags Key=Project,Value=Chess-DevSecOps Key=ManagedBy,Value=release-setup.sh >/dev/null
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY_NAME" \
  --policy-document "file://$perm_doc"
echo "Attached inline policy $POLICY_NAME to $ROLE_NAME."

# --- 3. ECR repositories ---
for repo in $REPOS; do
  if aws ecr describe-repositories --repository-names "$repo" --region "$REGION" >/dev/null 2>&1; then
    echo "ECR repo $repo exists."
  else
    echo "Creating ECR repo $repo ..."
    aws ecr create-repository --repository-name "$repo" --region "$REGION" \
      --image-tag-mutability MUTABLE \
      --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256 \
      --tags Key=Project,Value=Chess-DevSecOps >/dev/null
  fi
  aws ecr put-image-scanning-configuration --repository-name "$repo" --region "$REGION" \
    --image-scanning-configuration scanOnPush=true >/dev/null
  aws ecr put-lifecycle-policy --repository-name "$repo" --region "$REGION" \
    --lifecycle-policy-text "file://$SCRIPT_DIR/ecr-lifecycle-policy.json" >/dev/null
  echo "Configured scan-on-push + lifecycle for $repo."
done

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
trap - EXIT
rm -f "$trust_doc" "$perm_doc"
echo
echo "SETUP COMPLETE"
echo "  Role ARN (GitHub variable AWS_RELEASE_ROLE_ARN): $ROLE_ARN"
echo "  Region   (GitHub variable AWS_REGION):           $REGION"
echo "Next: create the 'production' GitHub Environment (deployment branches: main),"
echo "then push to main and watch the 'release' workflow. Validation commands:"
echo "  aws ecr describe-images --repository-name chess-backend --region $REGION --query 'imageDetails[0].{digest:imageDigest,tags:imageTags}'"
