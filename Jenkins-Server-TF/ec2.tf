resource "aws_instance" "ec2" {
  ami                    = data.aws_ami.ami.image_id
  instance_type          = var.instance-type
  key_name               = var.key-name
  subnet_id              = aws_subnet.public-subnet.id
  vpc_security_group_ids = [aws_security_group.security-group.id]
  iam_instance_profile   = aws_iam_instance_profile.instance-profile.name

  root_block_device {
    volume_size           = var.volume-size    # 40GB
    volume_type           = "gp3"              # تحديث: gp3 أسرع وأرخص من gp2
    delete_on_termination = true
    encrypted             = true               # جديد: تشفير القرص
  }

  # تثبيت الأدوات تلقائياً عند أول تشغيل
  user_data = templatefile("${path.module}/tools-install.sh", {
    region = var.aws-region
  })

  # جديد: تفعيل IMDSv2 فقط (أكثر أماناً من IMDSv1)
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"    # يفرض IMDSv2
    http_put_response_hop_limit = 1
  }

  tags = { Name = var.instance-name }
}
