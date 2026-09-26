# Wave 4 — AWS infrastructure foundation (Terraform)

Staging-first, private-networking-first foundation: VPC → EKS (private nodes) →
RDS PostgreSQL (private data subnets), with OIDC/IRSA trust ready for Wave 5.

```text
Internet
   │
   ├─► public subnets (IGW route) ── NAT GW ──► app subnets egress (ECR/API)
   │                                └─► (Wave 5: public ALB)
   │
   ├─► private APP subnets ── EKS control-plane ENIs + worker nodes (no public IP)
   │        │  (EKS-managed cluster SG)
   │        └─► TCP 5432 ──► private DATA subnets ── RDS (no Internet route at all)
   │
   └─► S3 gateway endpoint (free): ECR image layers bypass NAT
```

| Item | Staging (this wave) | Production (planned, NOT applied) |
|---|---|---|
| AZs | 2 | 3 |
| NAT | 1 (cost; AZ-failure tradeoff documented below) | 1 per AZ |
| EKS nodes | 2× t3.medium (min 1, max 3) | 3× t3.medium (min 2, max 6) |
| EKS API | private; public only on explicit owner CIDRs | private; public only on explicit owner CIDRs |
| RDS | db.t4g.micro, single-AZ, 7d backups, no final snapshot | db.t4g.small, Multi-AZ, 30d backups + final snapshot |
| Deletion protection | **ON (both)** — destroying a database is always a deliberate two-step | ON |
| Logs | control-plane (api/audit/authenticator) + VPC flow logs, 30d | same signals, 90d |

Backend stays **1 replica/process** — §26 constraint is explicit: node sizing is
platform headroom, not application scale-out (Wave 7).

## Layout

```text
terraform/
├── README.md                  # this file (architecture + runbook)
├── bootstrap/                 # ONE-TIME state bucket setup (local state)
│   ├── versions.tf main.tf variables.tf outputs.tf
│   └── deployer-policy.json   # scoped IAM for env applies (best-effort, untested — see below)
├── modules/
│   ├── networking/            # VPC, IGW, subnets, NAT, routes, S3 endpoint, flow logs
│   ├── eks/                   # cluster, nodes, KMS envelope key, logging, OIDC, access entries, add-ons
│   ├── rds/                   # subnet group, param group (TLS), SG (5432 from EKS only), instance, KMS key
│   └── iam/                   # IRSA role factory (EMPTY in Wave 4 — foundation only)
└── environments/
    ├── staging/               # 2 AZ / single NAT / single-AZ RDS — the Wave 4 target
    └── production/            # PLANNED VALUES — DO NOT APPLY (no cutover until Waves 5-8)
```

## Key decisions (see `docs/security/wave4-baseline.md` for the full record)

1. **VPC `10.20.0.0/16` (staging) / `10.30.0.0/16` (prod)** — never
   `10.0.0.0/16`: the legacy Jenkins VPC may still exist in the account and the
   two must never overlap (peering safety during migration).
2. **Single NAT in staging, per-AZ NAT in production.** One NAT ≈ $32/mo +
   data processing; three ≈ $96/mo + processing. Staging accepts the AZ-failure
   tradeoff (documented: if AZ-a fails, app-subnet egress drops until NAT is
   re-created — recovery is a one-variable apply). Variable flips it.
3. **EKS-managed security groups only.** Hand-rolled node↔control-plane rules
   break clusters subtly; the EKS-managed cluster SG (scoped to cluster
   members) is the documented RDS ingress source. Pod-level segmentation moves
   to Kubernetes NetworkPolicy in Wave 7/8, not hand-cut SGs.
4. **RDS `manage_master_user_password`** — no password exists in Terraform, in
   state (ARN only), or in any output. Wave 5 consumes the secret ARN via ESO.
5. **S3 native state locking** (`use_lockfile`, Terraform ≥ 1.11). No DynamoDB
   lock table — that pattern is deprecated and legacy-only.
6. **AWS provider `~> 5.0`** — every pattern here is written against the v5
   schema; v6 migration waits until `init` can run user-side (no blind major).
7. **EKS `1.35` default, floor `1.34`** — versions below are past EKS standard
   support at design time (Sept 2026). Re-verify before apply:
   `aws eks describe-cluster-versions`.
8. **Deployer credentials: owner/admin + MFA for Wave 4 bootstrap.**
   `bootstrap/deployer-policy.json` is a best-effort scoped policy for
   environment applies — USER-SIDE AWS VALIDATION REQUIRED (expand on
   `AccessDenied`, never commit credentials). A GitHub-OIDC deploy role arrives
   with GitOps automation in Wave 5; no CI applies in Wave 4.
9. **No CloudTrail in this tree** — account-level concern; the runbook verifies
   one exists instead of creating a duplicate. No interface VPC endpoints yet
   (each ≈ $7/mo + processing; S3 gateway is free and covers ECR layers).

## Cost drivers (staging, us-east-1, ≈ Sept 2026 pricing — verify, AWS changes these)

| Driver | ≈ $/mo | Note |
|---|---|---|
| EKS control plane | 73 | flat per cluster |
| Nodes 2× t3.medium | ~60 | on-demand; headroom, not app scaling |
| NAT (1) + processing | ~32 + usage | dominant *variable* cost; S3 endpoint offloads ECR layers |
| RDS db.t4g.micro + 20 GB gp3 | ~13 + ~2 | single-AZ; backups within retention are modest |
| CloudWatch logs (EKS + flow + RDS) | usage | bounded by 30d retention; watch `aws eks` audit volume |
| KMS (2 keys) | ~2 | rotation is free; API calls are pennies |
| EIP (1 attached) | 0 | attached EIPs are free |
| **Staging total** | **≈ $185 + usage** | NAT data + log ingestion dominate variability |

Production (≈3 AZ, per-AZ NAT, Multi-AZ RDS small, 3 nodes): ≈ $400–500 + usage.
Cheapest-possible was NOT the goal: private subnets, encryption, logging and
deletion protection are non-negotiable; savings come from single NAT, small
instances, short retention, and no interface endpoints.

## USER-SIDE AWS RUNBOOK (every step: USER-SIDE AWS VALIDATION REQUIRED)

Prerequisites: AWS CLI v2, Terraform ≥ 1.11, an owner/admin IAM identity with
MFA, `us-east-1` (or change `aws_region` consistently everywhere).

### 1. AWS authentication

```bash
aws sts get-caller-identity
# expect: your Account + owner/admin Arn. Configure first if needed:
# aws configure sso   # (or `aws configure` for static keys — rotate after)
```

### 2. Terraform backend setup (ONE-TIME per account)

```bash
cd terraform/bootstrap
terraform init
terraform apply -var="state_bucket_name=<account-id>-chess-terraform-state"
# note the state_bucket_name output; then remove local bootstrap state:
rm -f terraform.tfstate terraform.tfstate.backup .terraform.lock.hcl
rm -rf .terraform/
```

### 3. Staging backend config + tfvars (git-ignored copies)

```bash
cd ../environments/staging
cp backend.staging.hcl.example backend.local.hcl   # set bucket = from step 2
cp terraform.tfvars.example terraform.tfvars       # set cluster_admin_role_arn
# OPTIONAL: add eks_public_access_cidrs = ["<your-ip>/32"] for kubectl without VPN
```

### 4. Terraform init / plan / apply staging

```bash
terraform init -backend-config=backend.local.hcl
terraform fmt -check -recursive
terraform validate
terraform plan -out=staging.tfplan   # REVIEW every resource before proceeding
terraform apply staging.tfplan       # ~15-20 min (EKS + RDS)
```

Rollback rule (always): revert code → new plan → review → apply. NEVER
`terraform destroy` as routine rollback; NEVER destroy RDS for an app change
(deletion protection blocks it anyway — that is intentional).

### 5. Verify VPC / subnets / routing / NAT

```bash
aws ec2 describe-vpcs --filters Name=tag:Name,Values=chess-staging-vpc \
  --query 'Vpcs[0].[VpcId,CidrBlock]' --output text
aws ec2 describe-subnets --filters Name=vpc-id,Values=<vpc-id> \
  --query 'Subnets[].[Tags[?Key==`Name`]|[0].Value,AvailabilityZone,CidrBlock,MapPublicIpOnLaunch]' \
  --output table
# expect: 2 public (map-public true) + 2 app + 2 data (map-public false)
aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=<vpc-id> \
  --query 'NatGateways[].[NatGatewayId,State,SubnetId]' --output table
# expect: 1 available (staging)
```

### 6. Verify EKS (cluster, nodes, endpoint, OIDC)

```bash
aws eks describe-cluster --name chess-staging-eks --region us-east-1 \
  --query 'cluster.[version,status,endpointPublicAccess,endpointPrivateAccess,resourcesVpcConfig.clusterSecurityGroupId]' \
  --output text
aws eks list-nodegroups --cluster-name chess-staging-eks --region us-east-1
aws eks describe-nodegroup --cluster-name chess-staging-eks \
  --nodegroup-name chess-staging-eks-ng --region us-east-1 \
  --query 'nodegroup.[status,scalingConfig,amiType,subnets]' --output json
aws iam list-open-id-connect-providers   # expect: provider for the cluster issuer
aws eks describe-cluster --name chess-staging-eks --region us-east-1 \
  --query 'cluster.identity.oidc.issuer' --output text   # compare issuer URLs match
```

### 7. Verify kubectl (needs step-3 public CIDR or private network path)

```bash
aws eks update-kubeconfig --region us-east-1 --name chess-staging-eks
kubectl get nodes -o wide     # expect: 2 Ready, PRIVATE IPs only (10.20.x.x)
kubectl -n kube-system get pods   # expect: coredns / aws-node / kube-proxy Running
```

### 8. Verify RDS (privacy, encryption, backups, TLS)

```bash
aws rds describe-db-instances --db-instance-identifier chess-staging-postgres \
  --query 'DBInstances[0].[DBInstanceStatus,Engine,EngineVersion,MultiAZ,
    PubliclyAccessible,StorageEncrypted,BackupRetentionPeriod,
    DeletionProtection,LatestRestorableTime]' --output text
# expect: available | postgres | 16.x | False | False | True | 7 | True | <timestamp>
aws rds describe-db-parameters --db-parameter-group-name chess-staging-pg16 \
  --query 'Parameters[?ParameterName==`rds.force_ssl`]' --output json
# expect: Applied (1) — TLS enforced
aws rds describe-db-instances --db-instance-identifier chess-staging-postgres \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text
# expect: arn:aws:secretsmanager:... (RDS-managed; Terraform never saw the value)
```

### 9. Verify security groups (matrix §M)

```bash
# RDS SG: exactly ONE ingress rule — 5432 from the EKS cluster SG, zero egress.
aws ec2 describe-security-groups --filters Name=group-name,Values=chess-staging-rds \
  --query 'SecurityGroups[0].[IpPermissions,IpPermissionsEgress]' --output json
# No 0.0.0.0/0 ingress on any Wave 4 SG:
aws ec2 describe-security-groups --filters Name=vpc-id,Values=<vpc-id> \
  --query 'SecurityGroups[].[GroupName,IpPermissions[?IpRanges[?CidrIp==`0.0.0.0/0`]]]' \
  --output json
```

### 10. Verify encryption (KMS rotation, envelope)

```bash
aws kms describe-key --key-id alias/chess-staging-eks-secrets \
  --query 'KeyMetadata.[KeyState,Enabled]' --output text
aws kms get-key-rotation-status --key-id alias/chess-staging-eks-secrets
aws kms get-key-rotation-status --key-id alias/chess-staging-rds
aws eks describe-cluster --name chess-staging-eks --region us-east-1 \
  --query 'cluster.encryptionConfig' --output json   # expect: provider key + ["secrets"]
```

### 11. Verify backups / PITR foundation

```bash
aws rds describe-db-snapshots --db-instance-identifier chess-staging-postgres \
  --snapshot-type automated --query 'DBSnapshots[0].[Status,SnapshotType]' --output text
# LatestRestorableTime from step 8 proves PITR. Restore drill (staging only):
# aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier \
#   chess-staging-postgres --target-db-instance-identifier chess-staging-restore-drill \
#   --use-latest-restorable-time   # then delete the drill instance after verification
```

### 12. Verify logging (control-plane, flow logs, CloudTrail)

```bash
aws logs describe-log-groups --log-group-name-prefix /aws/eks/chess-staging-eks
aws logs describe-log-groups --log-group-name-prefix /aws/vpc/chess-staging
aws cloudtrail describe-trails --query 'trailList[].[Name,IsMultiRegionTrail,LogFileValidationEnabled]'
# expect: ≥1 account trail (created outside this tree — do NOT duplicate it here)
```

### 13. Teardown (staging ONLY, deliberate two-step — never routine)

```bash
# 1) set deletion_protection=false equivalent: edit rds module call? NO —
# protection is hardcoded. Intentional teardown = code change + apply + destroy:
#   a. temporarily flip deletion_protection in modules/rds/main.tf, apply,
#   b. terraform destroy (review!), c. revert the code change.
# 2) RDS final snapshot: staging skips it (skip_final_snapshot=true);
#    take a MANUAL snapshot first if the data matters.
```

## Wave 5 handoff (prerequisites this tree provides)

- VPC + private subnets + EKS cluster + OIDC provider + node group: ready.
- IRSA factory (`modules/iam`, `roles = {}`): Wave 5 adds EBS CSI, ALB
  controller, ESO roles — no new trust plumbing.
- RDS endpoint + managed-secret ARN (outputs): Wave 5 ESO source; app
  least-privilege DB user (`chess_user`) is created by Wave 5 migration-job,
  NOT by Terraform.
- Missing on purpose: ALB + ACM + Route53, ECR pull-through details, image
  deployment, ESO/ArgoCD installs, HPA/PDB, NetworkPolicy, Redis, S3 uploads.
