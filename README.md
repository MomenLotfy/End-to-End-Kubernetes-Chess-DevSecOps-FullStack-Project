# ♟ Chess DevSecOps — Full-Stack Project

> End-to-End Kubernetes DevSecOps مشروع كامل: React + Node.js + PostgreSQL على AWS EKS

[![EKS](https://img.shields.io/badge/EKS-1.33-orange)](https://aws.amazon.com/eks/)
[![ArgoCD](https://img.shields.io/badge/ArgoCD-v3.3.9-blue)](https://argoproj.github.io/argo-cd/)
[![Node](https://img.shields.io/badge/Node.js-22%20LTS-green)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue)](https://www.postgresql.org/)

---

## 🏗️ هيكل المشروع

```
chess-devsecops/
├── Chess-Frontend/              ← React 18 — Chess Game + Auth + Leaderboard
│   ├── src/App.js               ← اللعبة + JWT Auth + API calls
│   ├── Dockerfile               ← Multi-Stage → nginx (~25MB)
│   └── nginx.conf
│
├── Chess-Backend/               ← Node.js + Express + Socket.io
│   ├── src/
│   │   ├── server.js            ← Entry Point
│   │   ├── routes/auth.js       ← Register / Login / Profile
│   │   ├── routes/leaderboard.js← Top Scores / Save / History
│   │   ├── routes/game.js       ← Stats / Active Games
│   │   ├── models/User.js       ← PostgreSQL User Model
│   │   ├── models/Score.js      ← PostgreSQL Score Model
│   │   ├── middleware/auth.js   ← JWT Middleware
│   │   ├── socket/gameSocket.js ← Socket.io Local Multiplayer
│   │   └── config/db.js         ← PostgreSQL Connection Pool
│   └── Dockerfile               ← Multi-Stage → node:22-alpine
│
├── Database/
│   └── migrations/001_init.sql  ← Schema: users + scores
│
├── Manifest-file/               ← Kubernetes YAMLs
│   ├── infrastructure.yml       ← Namespace + RBAC + HPA + NetworkPolicy
│   ├── deployment-frontend.yml  ← Frontend Deployment + LoadBalancer
│   ├── deployment-backend.yml   ← Backend Deployment + ClusterIP
│   ├── deployment-postgres.yml  ← PostgreSQL StatefulSet + PVC
│   └── secrets.yml              ← DB + JWT Secrets (لا ترفع لـ GitHub!)
│
├── EKS-TF/                      ← Terraform: كتلة EKS 1.33
├── Jenkins-Server-TF/           ← Terraform: خادم Jenkins
├── Jenkins-Pipeline-Code/
│   ├── Jenkinsfile-EKS-Terraform
│   ├── Jenkinsfile-ChessFrontend ← 12 مرحلة + Slack/Email
│   └── Jenkinsfile-ChessBackend  ← 12 مرحلة + Slack/Email
├── .github/workflows/
│   ├── chess-frontend-ci.yml    ← Secret Scan + Trivy + Trigger Jenkins
│   ├── chess-backend-ci.yml     ← Secret Scan + Trivy + Trigger Jenkins
│   ├── terraform-validation.yml ← tfsec + Checkov + kubeconform
│   └── dependency-security.yml  ← Weekly npm audit + Docker scan
├── monitoring/                  ← Prometheus + Grafana
└── scripts/                     ← bootstrap + argocd + cleanup
```

---

## 🔄 Flow الكامل

```
git push Chess-Frontend/**
         │
         ▼
GitHub Actions (2 دقيقة)
  ├── gitleaks Secret Scan
  ├── ESLint Code Lint
  ├── Trivy FS Scan → GitHub Security
  ├── Hadolint Dockerfile Lint
  └── Trigger Jenkins via API
              │
              ▼
        Jenkins Pipeline (15 دقيقة)
          ├── SonarQube + Quality Gate
          ├── OWASP Dependency-Check
          ├── Docker Build (Multi-Stage ~25MB)
          ├── Docker Push → Docker Hub
          ├── Trivy Image Scan
          └── Update Manifest → git push
                      │
                      ▼
                ArgoCD (دقيقة)
                  └── Rolling Update على EKS
                              │
                              ▼
                    ┌─────────────────┐
                    │  Chess Frontend │ ← LoadBalancer
                    │  Chess Backend  │ ← ClusterIP
                    │  PostgreSQL     │ ← StatefulSet + PVC
                    └─────────────────┘
```

---

## 🌐 API Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | تسجيل مستخدم جديد |
| POST | `/api/auth/login` | تسجيل الدخول |
| GET  | `/api/auth/profile` | بيانات المستخدم (JWT) |

### Leaderboard
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/leaderboard` | أعلى 10 نتائج |
| POST | `/api/leaderboard/save` | حفظ نتيجة لعبة (JWT) |
| GET  | `/api/leaderboard/me` | إحصائياتي (JWT) |
| GET  | `/api/leaderboard/history` | تاريخ ألعابي (JWT) |

### Game
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/game/active` | عدد الألعاب النشطة |
| GET | `/api/game/stats` | إحصائيات عامة |
| GET | `/health` | Health Check |

### Socket.io Events
| Event | Direction | Description |
|-------|-----------|-------------|
| `create_room` | Client → Server | إنشاء غرفة لعب |
| `join_room` | Client → Server | الانضمام لغرفة |
| `game_start` | Server → Client | بدء اللعبة |
| `make_move` | Client → Server | تنفيذ حركة |
| `move_made` | Server → Client | تأكيد الحركة |
| `game_over` | Client → Server | إنهاء اللعبة |
| `resign` | Client → Server | الاستسلام |

---

## 🚀 التشغيل من الصفر

```bash
# 1. Bootstrap
export AWS_KEY_NAME="your-key-name"
bash scripts/bootstrap.sh

# 2. إعداد Jenkins (Plugins + Credentials)

# 3. إنشاء EKS من Jenkins Pipeline
#    → EKS-Terraform-Pipeline → apply

# 4. تثبيت ArgoCD
bash scripts/install-argocd.sh

# 5. إنشاء Secrets في Kubernetes
kubectl apply -f Manifest-file/secrets.yml

# 6. ربط ArgoCD بـ GitHub → Manifest-file/

# 7. تشغيل Pipelines
#    → Chess-Frontend-Pipeline
#    → Chess-Backend-Pipeline

# 8. المراقبة
bash scripts/install-monitoring.sh

# 9. الوصول للتطبيق
kubectl get svc chess-frontend-service -n chess
```

---

## ⚙️ GitHub Secrets المطلوبة

| Secret | الوصف |
|--------|-------|
| `SLACK_WEBHOOK_URL` | Slack Webhook |
| `JENKINS_URL` | `http://JENKINS_IP:8080` |
| `JENKINS_USER` | `admin` |
| `JENKINS_TOKEN` | Jenkins API Token |
| `JENKINS_JOB_FRONTEND_NAME` | `Chess-Frontend-Pipeline` |
| `JENKINS_JOB_BACKEND_NAME` | `Chess-Backend-Pipeline` |
| `DOCKERHUB_USERNAME` | Docker Hub username |
| `DOCKERHUB_TOKEN` | Docker Hub token |

---

## 💰 التكلفة التقديرية

| المورد | التكلفة/ساعة |
|--------|-------------|
| EC2 Jenkins (t3.2xlarge) | ~$0.33 |
| EKS Cluster | ~$0.10 |
| EKS Nodes ×2 (t3.medium) | ~$0.083 |
| Load Balancers | ~$0.05 |
| EBS (PostgreSQL 5GB) | ~$0.005 |
| **المجموع** | **~$0.57/ساعة** |

> ⚠️ شغّل `make destroy` عند الانتهاء!
