resource "aws_vpc" "vpc" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true    # جديد: مطلوب لـ EKS
  enable_dns_support   = true

  tags = { Name = var.vpc-name }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.vpc.id
  tags   = { Name = var.igw-name }
}

resource "aws_subnet" "public-subnet" {
  vpc_id                  = aws_vpc.vpc.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.aws-region}a"
  map_public_ip_on_launch = true

  tags = {
    Name                     = var.subnet-name
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_route_table" "rt" {
  vpc_id = aws_vpc.vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = { Name = var.rt-name }
}

resource "aws_route_table_association" "rt-association" {
  route_table_id = aws_route_table.rt.id
  subnet_id      = aws_subnet.public-subnet.id
}

# ─── Security Group محسّن ─────────────────────────────────────
# تحسين أمني: تقييد SSH بـ IP محدد (غيّر 0.0.0.0/0 لـ IP الخاص بك)
resource "aws_security_group" "security-group" {
  vpc_id      = aws_vpc.vpc.id
  description = "Jenkins Server - DevSecOps Project"

  # SSH — يُفضَّل تقييده لـ IP المكتب فقط
  ingress {
    description = "SSH Access"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]    # ⚠ غيّر لـ IP الخاص بك في الإنتاج
  }

  # Jenkins UI
  ingress {
    description = "Jenkins Web UI"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # SonarQube UI
  ingress {
    description = "SonarQube Web UI"
    from_port   = 9000
    to_port     = 9000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # جديد: منفذ Jenkins Agent (JNLP)
  ingress {
    description = "Jenkins Agent JNLP"
    from_port   = 50000
    to_port     = 50000
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]    # داخلي فقط
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = var.sg-name }
}
