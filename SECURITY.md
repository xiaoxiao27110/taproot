# Security Policy

## Supported Versions

Taproot is pre-1.0 software. Security fixes target the latest released version.

## Reporting a Vulnerability

Please report security issues privately by emailing the maintainer or by opening a private vulnerability report on GitHub once the public repository is available:

https://github.com/xiaoxiao27110/taproot/security/advisories/new

Do not open a public issue for vulnerabilities involving credential exposure, command execution, remote filesystem access, or approval bypasses.

## Security Model

Taproot runs locally and connects to configured nodes over SSH. Remote nodes do not need Taproot installed.

- Prefer SSH keys over passwords.
- `password` and `sudo_password` in `nodes.yaml` are stored in plaintext.
- `nodes.yaml`, `.taproot/`, history files, and approval files must not be committed.
- Taproot does not collect telemetry.
- High-risk remote operations require Taproot-side approval even if the local MCP client is unsandboxed.
