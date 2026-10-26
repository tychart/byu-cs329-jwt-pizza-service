# JWT Pizza Service infrastructure — the Terraform version of the course's
# cloudFormation/jwt-pizza-service.json template.
#
# It creates, in order:
#   1. an ECS cluster
#   2. two security groups (ALB and containers)
#   3. an ALB + target group + HTTPS listener
#   4. an ECS service that runs the task definition behind the ALB
#
# It does NOT create the ECR repository, the task definition, or the database.
# Those already exist (CI pushes images to ECR, and the task definition is
# registered once in the ECS console).

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.name
      ManagedBy = "terraform"
    }
  }
}

# All subnets in the VPC (the default VPC's subnets are all public, which is
# what an internet-facing ALB + Fargate task with a public IP needs).
data "aws_subnets" "all" {
  filter {
    name   = "vpc-id"
    values = [var.vpc_id]
  }
}

# The newest ACTIVE revision of the task definition. The task definition is
# registered outside of Terraform, so we look it up instead of copying its
# (long, changing) ARN into a variable.
data "aws_ecs_task_definition" "app" {
  task_definition = var.task_definition_family
}

# The existing security group, used by both the load balancer and the
# containers (exactly like the CloudFormation template's SecurityGroupIDs
# parameter). It already allows 443 in from the internet and 80 in from the
# load balancer. Terraform does not create or delete it.
data "aws_security_group" "app" {
  name = var.security_group_name
}

# --- ECS cluster -----------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = var.name
}

# --- Security group ---------------------------------------------------------
# Deliberately not created here: the stack reuses the existing
# var.security_group_name group (see the data block above).

# --- Load balancer ---------------------------------------------------------

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  subnets            = data.aws_subnets.all.ids
  security_groups    = [data.aws_security_group.app.id]

  # Keep it false so `terraform destroy` can remove the ALB without editing it.
  enable_deletion_protection = false
}

# The "pool" of containers the ALB sends traffic to.
resource "aws_lb_target_group" "this" {
  name        = var.name
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip" # required for Fargate
  vpc_id      = var.vpc_id

  health_check {
    path     = var.health_check_path
    protocol = "HTTP"
    matcher  = "200"
  }

  # Give in-flight requests 5 minutes to finish before a container is removed.
  deregistration_delay = 300
}

# The internet-facing HTTPS endpoint. This is what the DNS record points at.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06" # same policy the current listener uses

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

# --- ECS service -----------------------------------------------------------

resource "aws_ecs_service" "this" {
  name             = var.name
  cluster          = aws_ecs_cluster.this.id
  task_definition  = data.aws_ecs_task_definition.app.arn
  desired_count    = var.desired_count
  platform_version = "LATEST"

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT" # ~70% cheaper; "FARGATE" for guaranteed capacity
    weight            = 1
    base              = 0
  }

  # Rolling deploy: start the new task before stopping the old one, and roll
  # back automatically if the new task never becomes healthy.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = var.container_name
    container_port   = var.container_port
  }

  network_configuration {
    subnets          = data.aws_subnets.all.ids
    security_groups  = [data.aws_security_group.app.id]
    assign_public_ip = true # the task pulls its image from ECR over the internet
  }

  # The CI pipeline may point the service at a newer task definition revision
  # (`aws ecs update-service --force-new-deployment` combined with a new
  # revision). Without this, the next `terraform apply` would roll it back.
  lifecycle {
    ignore_changes = [task_definition]
  }

  # An ECS service cannot be created before its target group is attached to a
  # listener, so wait for the listener first.
  depends_on = [aws_lb_listener.https]
}
