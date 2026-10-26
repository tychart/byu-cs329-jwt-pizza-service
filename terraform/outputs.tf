output "load_balancer_dns_name" {
  description = "Point the pizza-service CNAME at this name (it changes every time the stack is recreated)"
  value       = aws_lb.this.dns_name
}

output "cluster_name" {
  description = "ECS cluster name (used by the CI pipeline)"
  value       = aws_ecs_cluster.this.name
}

output "service_name" {
  description = "ECS service name (used by the CI pipeline)"
  value       = aws_ecs_service.this.name
}

output "target_group_arn" {
  description = "ARN of the ALB target group"
  value       = aws_lb_target_group.this.arn
}

output "listener_arn" {
  description = "ARN of the HTTPS listener"
  value       = aws_lb_listener.https.arn
}
