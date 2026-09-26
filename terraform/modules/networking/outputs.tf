output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC CIDR block."
  value       = aws_vpc.this.cidr_block
}

output "azs" {
  description = "Availability Zones in use."
  value       = local.azs
}

output "public_subnet_ids" {
  description = "Public subnet IDs (NAT + future load balancers)."
  value       = [for s in aws_subnet.public : s.id]
}

output "app_subnet_ids" {
  description = "Private application subnet IDs (EKS nodes + control-plane ENIs)."
  value       = [for s in aws_subnet.app : s.id]
}

output "data_subnet_ids" {
  description = "Private data subnet IDs (RDS; no Internet route)."
  value       = [for s in aws_subnet.data : s.id]
}

output "nat_gateway_ids" {
  description = "NAT gateway IDs (1 staging, 1/AZ production)."
  value       = [for n in aws_nat_gateway.this : n.id]
}

output "s3_endpoint_id" {
  description = "S3 gateway VPC endpoint ID."
  value       = aws_vpc_endpoint.s3.id
}
