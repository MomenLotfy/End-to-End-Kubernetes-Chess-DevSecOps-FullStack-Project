#!/bin/bash
# ============================================================
# install-monitoring.sh — تثبيت Prometheus + Grafana
# الاستخدام: bash scripts/install-monitoring.sh
# ============================================================
set -euo pipefail

GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC}   $*"; }

# ─── 1. إضافة Helm Repos ──────────────────────────────────────
info "إضافة Helm repositories ..."
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add stable https://charts.helm.sh/stable
helm repo update
success "Helm repos محدَّثة"

# ─── 2. تثبيت kube-prometheus-stack ──────────────────────────
info "تثبيت Prometheus + Grafana + AlertManager ..."
helm upgrade --install monitoring \
    prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --create-namespace \
    --values monitoring/prometheus-values.yaml \
    --wait \
    --timeout 10m

success "kube-prometheus-stack مثبَّت"

# ─── 3. تطبيق ServiceMonitor لـ Tetris ───────────────────────
info "تطبيق ServiceMonitor لمراقبة Chess ..."
kubectl apply -f monitoring/servicemonitor.yaml
success "ServiceMonitor مُطبَّق"

# ─── 4. الحصول على روابط الوصول ──────────────────────────────
GRAFANA_URL=$(kubectl get svc monitoring-grafana -n monitoring \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "pending...")

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     المراقبة جاهزة!                   ║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  Grafana: http://$GRAFANA_URL          ${NC}"
echo -e "${GREEN}║  User:    admin                        ║${NC}"
echo -e "${GREEN}║  Pass:    ChangeMe123!                 ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
