#!/bin/bash
# ============================================================
# tools-install.sh — تثبيت الأدوات تلقائياً على Ubuntu 24.04 LTS
# النسخة المحدّثة: Node 22 LTS | kubectl 1.33 | ArgoCD 3.3
# ============================================================
set -euo pipefail

LOG="/var/log/tools-install.log"
exec > >(tee -a "$LOG") 2>&1

echo "============================================="
echo "بدء تثبيت الأدوات: $(date)"
echo "============================================="

# ─── تحديث النظام ──────────────────────────────────────────
apt-get update -y
apt-get upgrade -y
apt-get install -y \
  curl wget git unzip jq \
  apt-transport-https \
  ca-certificates \
  gnupg \
  lsb-release \
  software-properties-common

# ─── Java 17 (متطلب Jenkins) ───────────────────────────────
echo ">>> تثبيت Java 17..."
apt-get install -y openjdk-17-jdk
java --version

# ─── Jenkins ───────────────────────────────────────────────
echo ">>> تثبيت Jenkins..."
curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key \
  | tee /usr/share/keyrings/jenkins-keyring.asc > /dev/null

echo "deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc] \
  https://pkg.jenkins.io/debian-stable binary/" \
  | tee /etc/apt/sources.list.d/jenkins.list > /dev/null

apt-get update -y
apt-get install -y jenkins
systemctl enable jenkins
systemctl start jenkins

# ─── Docker ────────────────────────────────────────────────
echo ">>> تثبيت Docker..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) \
  signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin

usermod -aG docker jenkins
usermod -aG docker ubuntu
systemctl enable docker
systemctl start docker

# ─── SonarQube (Docker) ────────────────────────────────────
echo ">>> تثبيت SonarQube كـ Container..."
# انتظار Docker يستجيب
sleep 5
docker run -d \
  --name sonar \
  --restart unless-stopped \
  -p 9000:9000 \
  -e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true \
  sonarqube:lts-community

# ─── AWS CLI v2 ────────────────────────────────────────────
echo ">>> تثبيت AWS CLI..."
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "/tmp/awscliv2.zip"
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --update
aws --version
rm -rf /tmp/aws /tmp/awscliv2.zip

# ─── kubectl 1.33 (يطابق إصدار EKS) ───────────────────────
echo ">>> تثبيت kubectl 1.33..."
curl -fsSL "https://dl.k8s.io/release/v1.33.0/bin/linux/amd64/kubectl" \
  -o /usr/local/bin/kubectl
chmod +x /usr/local/bin/kubectl
kubectl version --client

# ─── Terraform (أحدث إصدار) ────────────────────────────────
echo ">>> تثبيت Terraform..."
wget -O- https://apt.releases.hashicorp.com/gpg \
  | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg

echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] \
  https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
  | tee /etc/apt/sources.list.d/hashicorp.list

apt-get update -y
apt-get install -y terraform
terraform version

# ─── Trivy (مسح الثغرات) ───────────────────────────────────
echo ">>> تثبيت Trivy..."
wget -qO - https://aquasecurity.github.io/trivy-repo/deb/public.key \
  | gpg --dearmor -o /usr/share/keyrings/trivy.gpg

echo "deb [signed-by=/usr/share/keyrings/trivy.gpg] \
  https://aquasecurity.github.io/trivy-repo/deb \
  $(lsb_release -sc) main" \
  | tee /etc/apt/sources.list.d/trivy.list

apt-get update -y
apt-get install -y trivy
trivy --version

# ─── Helm 3 (جديد: لإدارة Kubernetes charts) ──────────────
echo ">>> تثبيت Helm 3..."
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version

# ─── gitleaks (جديد: كشف الأسرار المخفية في الكود) ────────
echo ">>> تثبيت gitleaks..."
GITLEAKS_VERSION="8.18.4"
curl -fsSL \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
  | tar -xz -C /usr/local/bin gitleaks
gitleaks version

# ─── Node.js 22 LTS (جديد: للبناء المحلي) ─────────────────
echo ">>> تثبيت Node.js 22 LTS..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version
npm --version

# ─── إعدادات نهائية ────────────────────────────────────────
# منح Jenkins صلاحية تشغيل Docker
chmod 666 /var/run/docker.sock
systemctl restart jenkins

echo "============================================="
echo "اكتمل التثبيت: $(date)"
echo "Jenkins : http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):8080"
echo "SonarQube: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):9000"
echo "كلمة مرور Jenkins: $(cat /var/lib/jenkins/secrets/initialAdminPassword 2>/dev/null || echo 'انتظر بضع ثوانٍ وأعد المحاولة')"
echo "============================================="
