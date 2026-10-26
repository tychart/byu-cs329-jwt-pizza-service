# JWT Pizza Service infrastructure (Terraform)

The Terraform equivalent of the course's `cloudFormation/jwt-pizza-service.json`:
one command creates the ECS cluster, ECS service, ALB, target group and HTTPS
listener, and one command removes them again.

```
terraform/
├── main.tf            # every resource, in the order it is created
├── variables.tf       # inputs (most have defaults)
├── terraform.tfvars   # the two values that are specific to your AWS account
├── outputs.tf         # the ALB DNS name you need for DNS
└── .gitignore         # keeps the state file out of git
```

Terraform **does not** create the ECR repository, the task definition, the IAM
roles or the MySQL database — those already exist and are intentionally left
alone. The ECS service always deploys the newest ACTIVE revision of the
`jwt-pizza-service` task definition, so `terraform apply` never needs a version
number.

## Prerequisites

- Terraform ≥ 1.6 (`terraform version`)
- AWS credentials (`aws sts get-caller-identity` should print your account)
- The certificate in `terraform.tfvars` must live in **us-east-1** (an ALB can
  only use certificates from its own region). It is the wildcard
  `*.tychart.com` cert, so it covers `pizza-service.tychart.com`.

## 1. Delete the manually built backend once

Terraform cannot create a load balancer named `jwt-pizza-service` while the old
one exists, so remove the console-built stack first:

```sh
aws ecs update-service --cluster jwt-pizza-service --service jwt-pizza-service --desired-count 0
aws ecs delete-service  --cluster jwt-pizza-service --service jwt-pizza-service --force
aws elbv2 delete-load-balancer  --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:345594594463:loadbalancer/app/jwt-pizza-service/03b5ce7a97741fbc
aws elbv2 delete-target-group  --target-group-arn arn:aws:elasticloadbalancing:us-east-1:345594594463:targetgroup/jwt-pizza-service/4ab26fadc4fb510c
aws ecs delete-cluster --cluster jwt-pizza-service
```

(Waiting a minute or two between the service delete and the target-group delete
avoids `ResourceInUse`.)

## 2. Create the stack

```sh
cd terraform
terraform init      # first time only: downloads the AWS provider
terraform plan      # shows "7 to add" — nothing is changed yet
terraform apply     # creates the stack (~2 minutes)
```

Copy `load_balancer_dns_name` from the output:

```
load_balancer_dns_name = "jwt-pizza-service-1234567890.us-east-1.elb.amazonaws.com"
```

## 3. Point DNS at the new ALB

In Cloudflare, edit the `pizza-service.tychart.com` CNAME so its target is the
`load_balancer_dns_name` from step 2. Keep the proxy **off (DNS only)** — the DNS
record must resolve straight to the ALB, exactly like it did before.

Verify:

```sh
curl https://pizza-service.tychart.com/
# {"message":"welcome to JWT Pizza","version":"..."}
```

## 4. Deploy the app

Push to `main` (or run the workflow manually). The pipeline builds the image
into ECR and then runs `aws ecs update-service --force-new-deployment`, using
the cluster and service names that Terraform just created.

## Tearing it down

```sh
cd terraform
terraform destroy
```

This deletes the cluster, service, load balancer, listener, target group and
the two security groups. It keeps the ECR repository, task definitions, the
database and the ECR images, so bringing it back up is just
`terraform apply` + a DNS update + a CI run.

> **Wait a few minutes before re-applying.** ECS keeps the deleted service in
> `DRAINING` under the same name for up to the target group's 300s
> deregistration delay, and it refuses to create a new service with that name
> until draining finishes (`InvalidParameterException: Unable to Start a service
> that is still Draining`). If you hit it, just run `terraform apply` again once
> `aws ecs describe-services --cluster jwt-pizza-service --services jwt-pizza-service`
> reports the service as `MISSING`.

To pause the database bill without deleting data, stop it in the RDS console
(actions → *Stop temporarily*).

## Things to know

- `terraform.tfstate` stays on this machine and is git-ignored. It is the only
  record of what the stack owns, so don't delete it — if you lose it, remove the
  stack by hand or with `terraform import`.
- `terraform.tfvars` is safe to commit: IDs and ARNs, no secrets.
- The ECS service has `ignore_changes = [task_definition]` so that a task
  definition revision registered by CI is not rolled back by the next apply.
- Everything is tagged `Project=jwt-pizza-service`, `ManagedBy=terraform`.
