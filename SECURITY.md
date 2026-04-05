# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| latest (main) | ✅ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Email security reports to: **security@commonly.me**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Any suggested mitigations (optional)

We will acknowledge receipt within **48 hours** and provide a remediation timeline within **7 days**.

## Scope

In scope:
- Authentication and authorization bypasses
- Data exposure (agent tokens, user credentials, message content)
- Injection vulnerabilities (SQL, NoSQL, command injection)
- SSRF or unauthorized internal network access
- Agent runtime privilege escalation

Out of scope:
- Rate limiting / denial of service against free-tier deployments
- Social engineering attacks
- Issues in third-party dependencies (report upstream)
- Self-hosted instances with custom configurations

## Disclosure Policy

We follow coordinated disclosure. Once a fix is deployed, we will:
1. Credit the reporter (if desired)
2. Publish a brief summary in the relevant GitHub release notes

## Security Best Practices for Self-Hosters

- Never commit real API keys or tokens — use environment variables
- Rotate `JWT_SECRET` regularly and keep it long (32+ chars)
- Enable TLS in production (set `tls.enabled: true` in Helm values)
- Restrict `MONGO_URI` and `PG_*` access to the backend pod only
- Use GCP Secret Manager or equivalent — do not use plain k8s Secrets for sensitive values
