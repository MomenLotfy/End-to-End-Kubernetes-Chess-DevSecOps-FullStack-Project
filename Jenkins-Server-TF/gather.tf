# جلب أحدث Ubuntu 24.04 LTS تلقائياً (تحديث: كان 22.04)
data "aws_ami" "ami" {
  most_recent = true

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }

  # معرف Canonical (ناشر Ubuntu) الرسمي على AWS
  owners = ["099720109477"]
}
