# Runbook: ALB errors (CloudWatch-native; no Prometheus alert by design)

## 1. Symptoms

- Users report errors but app metrics look clean (5xx ratio low, pods healthy).
- ALB target health flipping; ACM/User reports of TLS failures.
- (No Prometheus alert fires: ALB is AWS-native — CloudWatch owns these signals.)

## 2. First checks

1. ALB-side or target-side? (`HTTPCode_ELB_5XX` = ALB itself; `HTTPCode_Target_5XX` = our pods; `UnHealthyHostCount` = targets failing checks.)
2. TLS or HTTP? (ACM expiry vs target errors.)

## 3. CloudWatch queries (authoritative)

Namespace `AWS/ApplicationELB`, dimensions `LoadBalancer=<full-name-from-TF-output>`:

```bash
LB=<alb-full-name>   # terraform output, or: aws elbv2 describe-load-balancers --region us-east-1
for M in RequestCount HTTPCode_Target_2XX_Count HTTPCode_Target_4XX_Count \
         HTTPCode_Target_5XX_Count HTTPCode_ELB_5XX_Count TargetResponseTime \
         HealthyHostCount UnHealthyHostCount RejectedConnectionCount; do
aws cloudwatch get-metric-statistics --region us-east-1 --namespace AWS/ApplicationELB \
  --metric-name $M --dimensions Name=LoadBalancer,Value=$LB \
  --start-time $(date -u -d '1 hour ago' +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Sum,Average,Maximum --output table
done
```

Correlate in Grafana: same window on Chess Platform Overview (rate/5xx/latency) + Backend/API (route 5xx).

## 4. kubectl commands

```bash
kubectl -n chess-staging get ingress chess -o wide   # ADDRESS + annotations
kubectl -n chess-staging describe ingress chess | grep -i "backends\|health\|error" | head -20
kubectl -n chess-staging get pods -l app.kubernetes.io/name=frontend   # targets must be Ready
aws elbv2 describe-target-health --region us-east-1 \
  --target-group-arn <from-ingress-or-TF>   # reason codes per target
```

## 5. Logs to inspect

- Frontend nginx access logs (Loki `{container="frontend"}`): status codes the ALB saw as targets.
- ALB access logs (S3, IF enabled — Wave 4 default off; USER-SIDE enablement documented in wave6-baseline §AWS).
- `aws-load-balancer-controller` pod logs (kube-system) for reconcile errors.

## 6. Likely causes

1. Targets unhealthy: frontend pods not Ready (readiness `/` failing?) or netpol blocking ALB→frontend:8080.
2. `HTTPCode_ELB_5XX` spike: ALB capacity/AZ issue (rare; check AWS Health) or malformed requests.
3. TLS errors: ACM cert expired/mismatched (console: ACM → certificate status; renewal is automatic for DNS-validated certs — check validation records).
4. Controller wedged: ingress annotations invalid after a chart change (controller logs name the field).

## 7. Safe remediation

- Unhealthy targets: fix the pods/netpol (frontend must answer `/` 200 on 8080 from VPC CIDR); targets recover automatically.
- Cert: re-validate in ACM (DNS records), no chart change needed (ARN stable).
- Controller: revert the ingress annotation change; never delete the Ingress (deletes the ALB + DNS).

## 8. Rollback/escalation

- Rollback = revert the ingress-affecting chart commit.
- Escalate: ELB-side 5xx with healthy targets, or multi-AZ target loss → platform page with CloudWatch tables + target-health output. AWS Health Dashboard check is part of triage.

## 9. Data/security cautions

- ALB access logs contain client IPs + full request paths — handle as sensitive; do not paste raw lines into tickets.
- Never expose backend directly "to test" (bypasses WAF-less ALB posture is wrong anyway — backend has no public path by design).
