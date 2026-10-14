# AWS deployment plan

**Deployment is optional for judging.** The rules require a repo plus a demo video, and judges may judge from those alone. A public HTTPS endpoint is still useful for (a) a live link in the Devpost entry and (b) connecting a real Alexa+ agent if access becomes available.

**Constraint that drives the choice:** memories are files and must persist. App Runner and Lambda have ephemeral filesystems, and App Runner cannot mount EFS, so they need extra work (see the alternatives table).

## Recommended: one EC2 Graviton instance + Docker + Caddy (automatic HTTPS)
Estimated cost, us-east-1 on-demand list prices. Verify in the AWS Pricing Calculator before launching; prices change.

| Item | Price | Per month |
|---|---|---|
| EC2 t4g.micro (2 vCPU burst, 1 GiB) | ~$0.0084/h | ~$6.1 |
| EBS gp3 8 GiB root volume | ~$0.08/GB-month | ~$0.6 |
| Public IPv4 address | ~$0.005/h | ~$3.6 |
| Data transfer out (demo traffic) | first 100 GB/month free | ~$0 |
| **Total** | | **≈ $10/month**, or **≈ $5** for the ~2-week judging window (Nov 9–20) if stopped afterwards |

The hackathon's AWS credit codes ran out on Oct 7, so expect to pay this yourself (or use any free-tier eligibility on your account).

### Steps (⚠️ = needs your AWS login)
1. ⚠️ Sign in to the AWS console, or create an account (needs a card and phone verification). Pick region **us-east-1**, or ap-southeast-1 (Singapore) for lower latency from Asia.
2. ⚠️ **Billing → Budgets → Create budget**: monthly cost budget of $15, with an email alert at 80%.
3. ⚠️ **EC2 → Key pairs → Create** `hippocampus-key` (ed25519, .pem). Download it and `chmod 400` it.
4. ⚠️ **EC2 → Launch instance**:
   - Name `hippocampus`. AMI: **Amazon Linux 2023 (arm64)**. Type: **t4g.micro**. Key pair `hippocampus-key`.
   - Network: create a security group allowing **SSH 22 from My IP**, **HTTP 80** and **HTTPS 443 from anywhere**.
   - Storage: 8 GiB gp3.
   - User data (paste):
     ```bash
     #!/bin/bash
     dnf install -y docker git
     systemctl enable --now docker
     ```
5. SSH in and run the app (replace `<repo-url>` with the GitHub repo):
   ```bash
   ssh -i hippocampus-key.pem ec2-user@<public-ip>
   git clone <repo-url> hippocampus && cd hippocampus
   sudo docker build -t hippocampus .
   sudo docker run -d --name hippocampus --restart unless-stopped \
     -p 127.0.0.1:3000:3000 -v /srv/hippocampus:/data \
     -e MEMORY_BUDGET_BYTES=50000000 hippocampus
   curl -s localhost:3000/health   # {"ok":true}
   ```
6. HTTPS with Caddy (automatic Let's Encrypt). Without a domain, use the free `<public-ip-with-dashes>.sslip.io` hostname:
   ```bash
   sudo docker run -d --name caddy --restart unless-stopped --network host \
     -v caddy_data:/data caddy:2 caddy reverse-proxy \
     --from <a-b-c-d>.sslip.io --to 127.0.0.1:3000
   ```
   The MCP endpoint is then `https://<a-b-c-d>.sslip.io/mcp`. Check it from your laptop:
   `MCP_URL=https://<a-b-c-d>.sslip.io/mcp npm run smoke`.
7. **Lock it down before going public.** Add `-e MCP_API_KEY=<long-random-string> -e DEMO_ROUTES=0` to the `docker run` in step 5. That makes `/mcp` require `Authorization: Bearer <key>` and disables the unauthenticated demo routes (`/api/*` and the brain view). Clients pass the same key via `MCP_API_KEY=… npm run smoke`.
8. ⚠️ **After judging (Nov 20):** EC2 → Instances → Terminate, then release any Elastic IP and delete the EBS snapshot (if any) and the budget.

### Code changes before deploy (no login needed; I can do these)
- ✅ Done: `MCP_API_KEY` bearer-token check on `/mcp` and the `DEMO_ROUTES=0` switch.
- Optional: nightly `tar` of `/srv/hippocampus` to S3 (≈ $0.023/GB-month) for backup.

## Alternatives
| Option | Pros | Cons | Est. cost |
|---|---|---|---|
| **Lightsail container (Nano)** | Simplest console flow, HTTPS URL included | No persistent disk: memories reset on redeploy unless synced to S3 | ~$7/month |
| **App Runner** | Managed HTTPS, autoscaling, deploy from GitHub or ECR | Ephemeral filesystem, no EFS → needs an S3-backed store (code change) | ~$5–10/month at minimal provisioned memory (0.25 vCPU / 0.5 GB), plus active-time CPU |
| **ECS Fargate + EFS + ALB** | Production-grade, durable shared storage | ALB alone ~$16+/month; more setup | ~$30/month |
| **Lambda + Function URL + EFS** | Pay per request, near $0 idle | Needs a VPC for EFS and an Express adapter; cold starts; the SSE live view won't work | ~$0–2/month (EFS ~$0.30/GB-month) |

## AWS Builder mini challenge (optional, needs login)
Hosting on EC2 alone probably counts only weakly as "incorporates AWS services with documented integrations". A stronger path: implement the stubbed `MEMORY_LLM=bedrock` summarizer and reconstruction using `@aws-sdk/client-bedrock-runtime`, and optionally Bedrock Titan embeddings in place of keyword vectors. ⚠️ This needs Bedrock model access enabled in your account plus IAM credentials. Cost is cents for a demo (a few thousand short summaries).
