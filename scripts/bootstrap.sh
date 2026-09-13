#!/bin/bash
# ============================================================
# bootstrap.sh — سكريبت الإعداد الأولي الكامل
# يُنشئ S3 Bucket + DynamoDB + يُشغّل Terraform
# الاستخدام: bash scripts/bootstrap.sh
# ============================================================
set -euo pipefail

# ─── الألوان ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── المتغيرات — عدّلها قبل التشغيل ──────────────────────────
BUCKET_NAME="${TF_STATE_BUCKET:-my-devsecops-tfstate}"
DYNAMO_TABLE="${TF_LOCK_TABLE:-terraform-lock-table}"
AWS_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
KEY_NAME="${AWS_KEY_NAME:-}"

# ─── التحقق من المتطلبات ──────────────────────────────────────
check_requirements() {
    info "فحص المتطلبات..."
    for cmd in aws terraform git; do
        command -v "$cmd" &>/dev/null || error "الأداة '$cmd' غير مثبتة"
    done
    [ -z "$KEY_NAME" ] && error "حدّد اسم مفتاح SSH: export AWS_KEY_NAME=your-key-name"
    aws sts get-caller-identity &>/dev/null || error "AWS CLI غير مُعدَّل. شغّل: aws configure"
    success "جميع المتطلبات متوفرة"
}

# ─── إنشاء S3 Bucket ──────────────────────────────────────────
create_s3_bucket() {
    info "إنشاء S3 Bucket: $BUCKET_NAME ..."
    if aws s3 ls "s3://$BUCKET_NAME" &>/dev/null; then
        warn "Bucket موجود مسبقاً: $BUCKET_NAME"
        return
    fi

    if [ "$AWS_REGION" = "us-east-1" ]; then
        aws s3api create-bucket \
            --bucket "$BUCKET_NAME" \
            --region "$AWS_REGION"
    else
        aws s3api create-bucket \
            --bucket "$BUCKET_NAME" \
            --region "$AWS_REGION" \
            --create-bucket-configuration LocationConstraint="$AWS_REGION"
    fi

    # تفعيل التشفير
    aws s3api put-bucket-encryption \
        --bucket "$BUCKET_NAME" \
        --server-side-encryption-configuration '{
            "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]
        }'

    # تفعيل Versioning
    aws s3api put-bucket-versioning \
        --bucket "$BUCKET_NAME" \
        --versioning-configuration Status=Enabled

    # منع الوصول العام
    aws s3api put-public-access-block \
        --bucket "$BUCKET_NAME" \
        --public-access-block-configuration \
            "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

    success "تم إنشاء S3 Bucket: $BUCKET_NAME"
}

# ─── إنشاء DynamoDB Table ─────────────────────────────────────
create_dynamodb_table() {
    info "إنشاء DynamoDB Table: $DYNAMO_TABLE ..."
    if aws dynamodb describe-table --table-name "$DYNAMO_TABLE" &>/dev/null; then
        warn "الجدول موجود مسبقاً: $DYNAMO_TABLE"
        return
    fi

    aws dynamodb create-table \
        --table-name "$DYNAMO_TABLE" \
        --attribute-definitions AttributeName=LockID,AttributeType=S \
        --key-schema AttributeName=LockID,KeyType=HASH \
        --billing-mode PAY_PER_REQUEST \
        --region "$AWS_REGION" \
        --tags Key=Project,Value=Chess-DevSecOps

    aws dynamodb wait table-exists --table-name "$DYNAMO_TABLE"
    success "تم إنشاء DynamoDB Table: $DYNAMO_TABLE"
}

# ─── تحديث ملفات Terraform ────────────────────────────────────
update_tf_configs() {
    info "تحديث ملفات Terraform بالـ bucket والجدول..."

    for tf_file in EKS-TF/backend.tf Jenkins-Server-TF/backend.tf; do
        sed -i "s/my-devsecops-tfstate/$BUCKET_NAME/g" "$tf_file"
        sed -i "s/terraform-lock-table/$DYNAMO_TABLE/g" "$tf_file"
    done

    # تحديث iam-policy.tf بالـ bucket الصحيح
    sed -i "s/my-devsecops-tfstate/$BUCKET_NAME/g" Jenkins-Server-TF/iam-policy.tf

    # تحديث key-name
    sed -i "s/your-key-name/$KEY_NAME/g" Jenkins-Server-TF/variables.tfvars

    success "تم تحديث ملفات Terraform"
}

# ─── تشغيل Terraform للـ Jenkins ──────────────────────────────
deploy_jenkins() {
    info "إنشاء خادم Jenkins..."
    cd Jenkins-Server-TF
    terraform init -upgrade
    terraform validate
    terraform plan -var-file=variables.tfvars -out=tfplan
    terraform apply tfplan

    JENKINS_IP=$(terraform output -raw jenkins_public_ip)
    success "خادم Jenkins جاهز!"
    echo ""
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Jenkins URL: http://$JENKINS_IP:8080  ${NC}"
    echo -e "${GREEN}  SonarQube:   http://$JENKINS_IP:9000  ${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo ""
    warn "انتظر 5-8 دقائق لاكتمال تثبيت الأدوات تلقائياً"
    warn "كلمة مرور Jenkins: ssh -i $KEY_NAME.pem ubuntu@$JENKINS_IP"
    warn "                   sudo cat /var/lib/jenkins/secrets/initialAdminPassword"
    cd ..
}

# ─── التشغيل الرئيسي ──────────────────────────────────────────
main() {
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  Chess DevSecOps — Bootstrap Setup      ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
    echo ""

    check_requirements
    create_s3_bucket
    create_dynamodb_table
    update_tf_configs
    deploy_jenkins
}

main "$@"
