#!/bin/bash
# ============================================================
# install-argocd.sh — تثبيت ArgoCD v3.3.9 على EKS
# الاستخدام: bash scripts/install-argocd.sh
# ============================================================
set -euo pipefail

ARGOCD_VERSION="v3.3.9"
CLUSTER_NAME="${EKS_CLUSTER:-Chess-EKS-Cluster}"
AWS_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }

# ─── 1. تحديث kubeconfig ──────────────────────────────────────
info "ربط kubectl بالكتلة $CLUSTER_NAME ..."
aws eks update-kubeconfig \
    --region "$AWS_REGION" \
    --name "$CLUSTER_NAME"

kubectl get nodes
success "kubectl مرتبط بالكتلة"

# ─── 2. إنشاء Namespace للتطبيق ───────────────────────────────
info "إنشاء namespace chess ..."
kubectl apply -f Manifest-file/namespace.yaml
success "Namespace chess جاهز"

# ─── 3. تطبيق RBAC ─────────────────────────────────────────────
info "تطبيق RBAC ..."
kubectl apply -f Manifest-file/rbac.yaml
success "RBAC مُطبَّق"

# ─── 4. تثبيت ArgoCD ──────────────────────────────────────────
info "تثبيت ArgoCD $ARGOCD_VERSION ..."
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -n argocd \
    --server-side \
    --force-conflicts \
    -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"

info "انتظار ArgoCD pods ..."
kubectl wait --for=condition=available \
    --timeout=300s \
    deployment/argocd-server \
    -n argocd

success "ArgoCD مثبَّت"

# ─── 5. تحويل ArgoCD لـ LoadBalancer ──────────────────────────
info "تفعيل LoadBalancer لـ ArgoCD ..."
kubectl patch svc argocd-server -n argocd \
    -p '{"spec": {"type": "LoadBalancer"}}'

info "انتظار تخصيص عنوان LoadBalancer ..."
sleep 30

ARGOCD_URL=$(kubectl get svc argocd-server -n argocd \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

# ─── 6. الحصول على كلمة المرور ────────────────────────────────
ARGOCD_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret \
    -o jsonpath="{.data.password}" | base64 -d)

# ─── 7. تثبيت Metrics Server (مطلوب لـ HPA) ──────────────────
info "تثبيت Metrics Server لـ HPA ..."
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
success "Metrics Server مثبَّت"

# ─── 8. تطبيق Network Policies ────────────────────────────────
info "تطبيق Network Policies ..."
kubectl apply -f Manifest-file/network-policy.yaml
success "Network Policies مُطبَّقة"

# ─── الملخص ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              ArgoCD جاهز!                            ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  URL:      https://$ARGOCD_URL  ${NC}"
echo -e "${GREEN}║  Username: admin                                      ║${NC}"
echo -e "${GREEN}║  Password: $ARGOCD_PASSWORD     ${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  الخطوة التالية: افتح URL وأنشئ Application يشير إلى ║${NC}"
echo -e "${GREEN}║  Manifest-file/ في مستودع GitHub الخاص بك            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
