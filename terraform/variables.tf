# Inputs. Everything that is the same every time has a default, so normally
# only `vpc_id` and `certificate_arn` (in terraform.tfvars) are set by hand.

variable "region" {
  description = "AWS region for every resource"
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Base name used for the cluster, service, load balancer and target group"
  type        = string
  default     = "jwt-pizza-service"
}

variable "vpc_id" {
  description = "VPC that the load balancer and containers live in (the default VPC)"
  type        = string
}

variable "certificate_arn" {
  description = "ARN of the us-east-1 ACM certificate used by the HTTPS listener"
  type        = string
}

variable "task_definition_family" {
  description = "ECS task definition family to deploy (its newest revision is used)"
  type        = string
  default     = "jwt-pizza-service"
}

variable "container_name" {
  description = "Container name inside the task definition that receives traffic"
  type        = string
  default     = "jwt-pizza-service"
}

variable "container_port" {
  description = "Port the container listens on"
  type        = number
  default     = 80
}

variable "health_check_path" {
  description = "HTTP path the target group polls to decide if a task is healthy"
  type        = string
  default     = "/"
}

variable "desired_count" {
  description = "How many container tasks to keep running"
  type        = number
  default     = 1
}
