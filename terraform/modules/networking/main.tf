# Wave 4 — networking module: VPC, public/app/data subnets, IGW, NAT, routes,
# S3 gateway endpoint (free ECR-layer path), optional VPC flow logs.
# No security groups here: compute/data SGs are owned by the eks/rds modules so each
# boundary documents its own ingress. No 0.0.0.0/0 ingress exists anywhere in Wave 4.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

locals {
  prefix = "${var.project}-${var.environment}"
  azs    = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # /20 slices of the /16 VPC CIDR. Public netnums 0-2, app 3-5, data 6-8 (room
  # for 3 AZs each); netnums 9-15 stay reserved for future growth. Example for
  # 10.20.0.0/16 with 2 AZs: public 10.20.0/16.0/20, app 10.20.48/64.0/20,
  # data 10.20.96/112.0/20.
  public_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  app_cidrs    = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, 3 + i)]
  data_cidrs   = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, 6 + i)]

  nat_count = var.single_nat_gateway ? 1 : var.az_count
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = "${local.prefix}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, { Name = "${local.prefix}-igw" })
}

# --- Public subnets: NAT gateways and (Wave 5+) public load balancers only. ---

resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = merge(
    var.tags,
    {
      Name                     = "${local.prefix}-public-${local.azs[count.index]}"
      "kubernetes.io/role/elb" = "1"
    },
    var.cluster_name != null ? { "kubernetes.io/cluster/${var.cluster_name}" = "shared" } : {}
  )
}

# --- Private application subnets: EKS control-plane ENIs + worker nodes. ---

resource "aws_subnet" "app" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.app_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false

  tags = merge(
    var.tags,
    {
      Name                              = "${local.prefix}-app-${local.azs[count.index]}"
      "kubernetes.io/role/internal-elb" = "1"
    },
    var.cluster_name != null ? { "kubernetes.io/cluster/${var.cluster_name}" = "shared" } : {}
  )
}

# --- Private data subnets: RDS only. No route to the Internet, not even NAT. ---

resource "aws_subnet" "data" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.data_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false

  tags = merge(var.tags, { Name = "${local.prefix}-data-${local.azs[count.index]}" })
}

# --- NAT: one gateway (staging, cost) or one per AZ (production, resilience). ---

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"

  tags = merge(var.tags, { Name = "${local.prefix}-nat-eip-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[var.single_nat_gateway ? 0 : count.index].id

  tags = merge(var.tags, { Name = "${local.prefix}-nat-${count.index}" })

  depends_on = [aws_internet_gateway.this]
}

# --- Routing ---

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  # Documented 0.0.0.0/0: public subnets must reach the Internet via IGW. Only
  # NAT gateways and (future) load balancers live here; no workloads, no data.
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(var.tags, { Name = "${local.prefix}-rt-public" })
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "app" {
  count  = local.nat_count
  vpc_id = aws_vpc.this.id

  # Documented 0.0.0.0/0: private app subnets egress via NAT (ECR pulls, patch
  # repos, AWS APIs). Inbound from the Internet is impossible: no IGW route and
  # no public IPs on these subnets.
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[count.index].id
  }

  tags = merge(var.tags, { Name = "${local.prefix}-rt-app-${count.index}" })
}

resource "aws_route_table_association" "app" {
  count          = var.az_count
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table" "data" {
  count  = local.nat_count
  vpc_id = aws_vpc.this.id

  # Intentionally NO default route: data subnets keep only the implicit local
  # route. RDS cannot initiate outbound connections at all.

  tags = merge(var.tags, { Name = "${local.prefix}-rt-data-${count.index}" })
}

resource "aws_route_table_association" "data" {
  count          = var.az_count
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data[var.single_nat_gateway ? 0 : count.index].id
}

# --- S3 gateway endpoint (free): keeps ECR image-layer traffic off the NAT
# gateway (lower cost, lower latency). Interface endpoints for ECR API/DKR, STS
# and CloudWatch Logs are a documented future cost optimization, not Wave 4. ---

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = setunion(
    [for rt in aws_route_table.app : rt.id],
    [for rt in aws_route_table.data : rt.id]
  )

  tags = merge(var.tags, { Name = "${local.prefix}-vpce-s3" })
}

# --- VPC flow logs to CloudWatch (rejected traffic is the intrusion signal). ---

resource "aws_cloudwatch_log_group" "flow_logs" {
  count             = var.enable_flow_logs ? 1 : 0
  name              = "/aws/vpc/${local.prefix}/flow-logs"
  retention_in_days = var.flow_log_retention_days

  tags = merge(var.tags, { Name = "${local.prefix}-flow-logs" })
}

resource "aws_iam_role" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0
  name  = "${local.prefix}-vpc-flow-logs"

  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${local.prefix}-vpc-flow-logs" })
}

resource "aws_iam_role_policy" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0
  name  = "${local.prefix}-vpc-flow-logs"
  role  = aws_iam_role.flow_logs[0].id

  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Sid    = "WriteFlowLogs"
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.flow_logs[0].arn}:*"
    }]
  })
}

resource "aws_flow_log" "this" {
  count                = var.enable_flow_logs ? 1 : 0
  vpc_id               = aws_vpc.this.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow_logs[0].arn
  iam_role_arn         = aws_iam_role.flow_logs[0].arn

  tags = merge(var.tags, { Name = "${local.prefix}-flow-logs" })
}
