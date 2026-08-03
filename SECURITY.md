# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately — **do not open a public GitHub
issue**. Email **khacvy93@gmail.com** with:

- A description of the vulnerability and its impact
- Steps to reproduce (a minimal repro is ideal)
- Any relevant logs, screenshots, or PoC code

You should get an acknowledgment within 3 business days. We'll work with you on
a fix and a disclosure timeline before anything is made public.

## Supported versions

Only the latest published release of `@vibe-oss/kvy` and the `main` branch of
this repository are supported with security fixes.

## Scope

Kvy's server is designed to be zero-knowledge — it stores and routes ciphertext
for session content, never plaintext. See
[`docs/kvy-system-design.md`](./docs/kvy-system-design.md) for the encryption
design and its documented trust boundary (what the server *can* see, and why).
Reports that a specific claim in that boundary doesn't hold are exactly the
kind of report we want.
