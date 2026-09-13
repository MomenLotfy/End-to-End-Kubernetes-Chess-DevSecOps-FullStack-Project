#!/bin/bash
# ============================================================
# cleanup.sh — تنظيف جميع موارد AWS بالترتيب الصحيح
# الاستخدام: bash scripts/cleanup.sh
# ============================================================
set -euo pipefail

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

AWS_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

warn "⚠  هذا السكريبت سيحذف جميع موارد المشروع على AWS!"
warn "⚠  التكلفة ستتوقف بعد اكتمال الحذف."
echo ""
read -rp "اكتب 'yes' للتأكيد: " confirm
[ "$confirm" != "yes" ] && { error "تم الإلغاء."; exit 0; }

# ─── 1. حذف LoadBalancers (يجب أولاً) ────────────────────────
info "حذف Kubernetes LoadBalancers ..."
kubectl delete svc chess-service -n chess        2>/dev/null || true
kubectl delete svc argocd-server  -n argocd        2>/dev/null || true
kubectl delete svc monitoring-grafana -n monitoring 2>/dev/null || true

info "انتظار حذف LoadBalancers من AWS (30 ثانية) ..."
sleep 30

# ─── 2. حذف Monitoring ────────────────────────────────────────
info "حذف Prometheus + Grafana ..."
helm uninstall monitoring -n monitoring 2>/dev/null || true
kubectl delete namespace monitoring    2>/dev/null || true

# ─── 3. حذف ArgoCD ────────────────────────────────────────────
info "حذف ArgoCD ..."
kubectl delete namespace argocd 2>/dev/null || true

# ─── 4. حذف التطبيق ───────────────────────────────────────────
info "حذف تطبيق Chess ..."
kubectl delete namespace chess 2>/dev/null || true

info "انتظار اكتمال حذف الموارد من AWS (60 ثانية) ..."
sleep 60

# ─── 5. حذف كتلة EKS بـ Terraform ────────────────────────────
info "حذف كتلة EKS ..."
cd EKS-TF
terraform init -upgrade
terraform destroy -auto-approve -var-file=variables.tfvars
cd ..
info "✅ كتلة EKS محذوفة"

# ─── 6. حذف خادم Jenkins بـ Terraform ────────────────────────
info "حذف خادم Jenkins ..."
cd Jenkins-Server-TF
terraform destroy -auto-approve -var-file=variables.tfvars
cd ..
info "✅ خادم Jenkins محذوف"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  تم حذف جميع الموارد بنجاح! ✅       ║${NC}"
echo -e "${GREEN}║  التكاليف توقفت الآن.                ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
