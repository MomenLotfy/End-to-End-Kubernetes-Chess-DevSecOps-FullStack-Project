# ============================================================
# Makefile — Chess DevSecOps Full-Stack
# ============================================================

.PHONY: help bootstrap deploy-eks argocd monitoring destroy status

help:
	@echo ""
	@echo "  Chess DevSecOps — الأوامر المتاحة:"
	@echo ""
	@echo "  make bootstrap      إعداد كامل من الصفر (S3 + DynamoDB + Jenkins)"
	@echo "  make deploy-eks     إنشاء كتلة EKS"
	@echo "  make argocd         تثبيت ArgoCD على EKS"
	@echo "  make monitoring     تثبيت Prometheus + Grafana"
	@echo "  make status         عرض حالة جميع الموارد"
	@echo "  make destroy        حذف جميع الموارد"
	@echo ""

bootstrap:
	@bash scripts/bootstrap.sh

deploy-eks:
	cd EKS-TF && \
	terraform init -upgrade && \
	terraform validate && \
	terraform plan -var-file=variables.tfvars && \
	terraform apply -var-file=variables.tfvars -auto-approve

argocd:
	@bash scripts/install-argocd.sh

monitoring:
	@bash scripts/install-monitoring.sh

status:
	@echo "=== EKS Nodes ==="
	@kubectl get nodes 2>/dev/null || echo "الكتلة غير متاحة"
	@echo ""
	@echo "=== Chess Pods ==="
	@kubectl get pods -n chess 2>/dev/null || echo "التطبيق غير مثبَّت"
	@echo ""
	@echo "=== Services ==="
	@kubectl get svc -n chess 2>/dev/null || true
	@echo ""
	@echo "=== HPA ==="
	@kubectl get hpa -n chess 2>/dev/null || echo "HPA غير مثبَّت"
	@echo ""
	@echo "=== ArgoCD ==="
	@kubectl get pods -n argocd 2>/dev/null || echo "ArgoCD غير مثبَّت"

destroy:
	@bash scripts/cleanup.sh
