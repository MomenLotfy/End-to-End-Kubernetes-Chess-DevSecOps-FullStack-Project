# ============================================================
# outputs.tf — جديد: يُظهر معلومات الخادم بعد الإنشاء
# ============================================================

output "jenkins_public_ip" {
  description = "Public IP of Jenkins server"
  value       = aws_instance.ec2.public_ip
}

output "jenkins_url" {
  description = "Jenkins web UI URL"
  value       = "http://${aws_instance.ec2.public_ip}:8080"
}

output "sonarqube_url" {
  description = "SonarQube web UI URL"
  value       = "http://${aws_instance.ec2.public_ip}:9000"
}

output "ssh_command" {
  description = "SSH command to connect to Jenkins server"
  value       = "ssh -i ${var.key-name}.pem ubuntu@${aws_instance.ec2.public_ip}"
}

output "ami_used" {
  description = "AMI ID used for the Jenkins server"
  value       = data.aws_ami.ami.image_id
}
