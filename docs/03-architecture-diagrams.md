# Phase 3 — Architecture Diagrams (Mermaid)

Render with any Mermaid viewer (GitHub renders ` ```mermaid ` natively).

## A. Application architecture

```mermaid
flowchart LR
    U[Browser] -->|HTTPS| N[Nginx 80/443]
    N -->|/api/*| B[Backend Express :5000]
    N -->|/socket.io/* WSS| B
    N -->|/uploads/* authed| B
    N -->|/* static + /stockfish WASM| S[React build]
    B -->|pg pool max 10| P[(PostgreSQL 16)]
    B -->|STARTTLS :587| M[SMTP]
    B -->|rw| V[(uploads_data WebP)]
    B -.->|in-process rooms + rate limits| B
```

## B. Local development architecture

```mermaid
flowchart TD
    D[Dev laptop] -->|docker compose up| F[frontend :8443 self-signed or mkcert]
    D -->|npm test| UT[unit tests]
    F --> BE[backend hot-reload optional override]
    BE --> PG[(postgres)]
    BE --> MP[Mailpit :8025]
    E2E[Playwright profile e2e] --> F
```

## C. Docker architecture

```mermaid
flowchart TD
    subgraph net[chess_internal bridge]
        PG[(chess-postgres<br/>no host port)]
        MG[chess-migration<br/>one-shot]
        BE[chess-backend<br/>ro-fs, caps dropped]
        FE[chess-frontend<br/>unpriv nginx 101]
    end
    PG -->|healthy| MG
    MG -->|completed| BE
    BE -->|healthy| FE
    FE -->|80:8080 443:8443| PUB((Internet))
```

## D. Kubernetes architecture (target)

```mermaid
flowchart TD
    ALB[ALB + ACM TLS] --> ING[Ingress chess.prod]
    ING --> FE[Deploy frontend 2-6 + HPA]
    ING --> BE[Deploy backend x1 Recreate]
    ING -->|/socket.io sticky| BE
    BE --> ESO[(ESO-synced Secrets)]
    BE --> RDS[(RDS Postgres)]
    BE --> S3[(S3 avatars via SDK)]
    FE -.->|static| CDN[CloudFront optional]
    NS[Namespace chess + Quota + LimitRange] --- FE
    NS --- BE
    NP[NetworkPolicies] --- FE
    NP --- BE
```

## E. AWS architecture (target)

```mermaid
flowchart LR
    R53[Route53] --> ALB[ALB public subnets]
    ACM[ACM] --- ALB
    ALB --> EKS[EKS nodes private subnets]
    EKS --> RDS[(RDS Multi-AZ private)]
    EKS --> ECR[ECR]
    EKS --> SM[Secrets Manager]
    EKS --> S3[S3]
    NAT[NAT GW] --- EKS
    IGW[IGW] --- ALB
    IGW --- NAT
    CW[CloudWatch + CloudTrail + KMS] --- EKS
```

## F. EKS architecture (target)

```mermaid
flowchart TD
    subgraph VPC[VPC 10.0.0.0/16]
        subgraph PUB[Public AZ-a/b]
            ALB[ALB]
        end
        subgraph PRIV[Private AZ-a/b]
            NG[Managed Node Group AL2023]
            PODS[Namespaces: chess, argocd, monitoring]
        end
    end
    IAM[IRSA: ESO, ALB controller, CloudWatch agent] --- NG
```

## G. CI/CD architecture (target)

```mermaid
flowchart LR
    PR[Pull Request] --> CI[GitHub Actions ci.yml]
    CI -->|pass| MERGE[Merge to main]
    MERGE --> REL[release.yml: build, scan, SBOM, sign, push ECR :sha]
    REL --> GB[Update gitops repo staging values]
    GB --> ARGO[ArgoCD sync staging]
    ARGO -->|soak + e2e ok| PROM[Promote digest to prod]
    PROM --> ARGO2[ArgoCD sync prod]
```

## H. DevSecOps pipeline (gates)

```mermaid
flowchart TD
    C[Checkout] --> SEC[Secrets: Gitleaks]
    SEC --> SAST[SAST: CodeQL/Semgrep]
    SAST --> SCA[SCA: npm audit + Trivy fs]
    SCA --> LINT[Lint + unit + integration]
    LINT --> DOCK[Build image]
    DOCK --> HSC[Hadolint + Trivy image HIGH/CRITICAL gate]
    HSC --> SBOM[SBOM Syft + provenance]
    SBOM --> IAC[Trivy config on terraform + kubeconform/kube-lint]
    IAC --> SIGN[Cosign sign]
    SIGN --> PUSH[Push ECR immutable :sha]
```

## I. GitOps architecture

```mermaid
flowchart LR
    APP[App repo: code + charts + CI] -->|release commits digest| OPS[GitOps repo: envs staging/prod]
    OPS --> ARGO[ArgoCD App-of-Apps]
    ARGO --> STG[EKS staging auto-sync]
    ARGO --> PRD[EKS prod manual promote]
    ARGO -->|drift| HEAL[self-heal + prune]
```

## J. Observability architecture

```mermaid
flowchart TD
    APP[Pods] -->|OTLP/logs| ALLOY[Grafana Alloy]
    APP -->|/metrics| PROM[Prometheus]
    ALLOY --> LOKI[Loki]
    PROM --> GRAF[Grafana]
    LOKI --> GRAF
    PROM --> AM[Alertmanager]
    AM --> SLACK[Slack + Pager]
```

## K. Security architecture

```mermaid
flowchart TD
    DEV[Developer + pre-commit] --> GH[GitHub: branch protection + CODEOWNERS + secret scan]
    GH --> PIPE[CI gates: SAST/SCA/image/IaC/admission]
    PIPE --> REG[ECR: immutable + scan-on-push + signature verify]
    REG --> CLU[EKS: RBAC + PSS + NetworkPolicy + Kyverno + ESO + KMS]
    CLU --> RUN[Runtime: Seccomp, ro-fs, no-new-privs, alerts]
    AUD[CloudTrail + audit logs] --- CLU
```

## L. Complete end-to-end production architecture

```mermaid
flowchart TD
    DEV[Developer] --> GH[GitHub PR]
    GH --> CI[CI: tests + SAST + SCA + secrets + IaC + image scan]
    CI --> MERGE[Merge]
    MERGE --> BUILD[Build + SBOM + sign]
    BUILD --> ECR[(ECR :sha immutable)]
    ECR --> OPS[GitOps repo env values]
    OPS --> ARGO[ArgoCD]
    ARGO --> EKS[EKS: frontend + backend x1 + workers later]
    EKS --> RDS[(RDS)] & S3[(S3)] & SM[Secrets Manager]
    EKS --> OBS[Prometheus + Grafana + Loki + Alloy]
    OBS --> ALERT[Alerts + SLOs + incidents]
    TF[Terraform: VPC/EKS/RDS/ECR/IAM] --> EKS
```
