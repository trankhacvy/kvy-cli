# Encryption Design

> **Status:** stub — outline + pointers only. Expand this doc as
> `@falcon/crypto` and its consumers actually land. Full detail currently
> lives in [`falcon-system-design.md` §5](../falcon-system-design.md#5-encryption-design-falconcrypto).
>
> **Rule:** this file is updated in the same PR as any crypto change
> (`plan.md` cross-cutting note). If key handling, wrapping, or the trust
> boundary changes and this doc doesn't, the PR is incomplete.

This document will describe how Falcon encrypts data end-to-end, as
implemented in `packages/crypto` (`@falcon/crypto`), and how those encrypted
payloads map onto the fields defined in [`protocol.md`](./protocol.md).

Core principle (design doc §1): **the server is blind.** All user content —
messages, metadata, diffs, attachments — is encrypted client-side. The
server routes ciphertext and coordination metadata only.

## 1. Key hierarchy

A single client-generated `masterSecret` (32 bytes, never leaves clients
unwrapped) is expanded via HKDF into purpose-scoped keys: an auth signing
keypair (server challenge/response), a content keypair (wraps per-session/
per-machine DEKs), an anonymous analytics id, and a legacy blob master key.
Each session/machine gets its own random DEK, sealed to the account's
content public key and stored server-side as an opaque wrapped blob.

- Unwrap never throws — decrypt failures return `null`; the record renders
  as "undecryptable" and sync continues.
- Recovery: `masterSecret` exportable as error-tolerant grouped Base32.

Design doc: [§5.1 Key hierarchy](../falcon-system-design.md#51-key-hierarchy).

## 2. Auth flows

Three flows: web-first sign-up (generate `masterSecret` client-side, derive
keys, OAuth binds identity for recovery/contact), sign-in on a returning
device (ed25519 challenge/response → JWT), and CLI pairing (ephemeral
x25519 keypair, QR/URL handoff, server relays an opaque box it cannot read).

Design doc: [§5.2 Auth flows](../falcon-system-design.md#52-auth-flows).

## 3. What the server can/cannot see

Published table (also required in public security docs, FR-6.4): the
server can see ids, public keys, seq numbers/versions/timestamps, and
routing metadata. It cannot see message/metadata/diff/attachment
plaintext, DEKs, or RPC params/results.

Design doc: [§5.3 What the server can/cannot see](../falcon-system-design.md#53-what-the-server-cancannot-see-published-table-fr-64).

## 4. Trust boundary (honest E2E boundary)

The E2E guarantee is strongest for the **CLI** (installed, checksummed
binary). For the **web app**, encryption protects against DB breach and
passive operator access, but a compromised server could in principle ship
key-exfiltrating JavaScript. Required mitigations: separate origin from the
API, strict CSP, Subresource Integrity, reproducible builds with checksums,
and CLI-as-key-origin as the recommended setup. This caveat must appear
wherever E2E claims are made publicly — never marketed without it.

Design doc: [§5.3 trust boundary](../falcon-system-design.md#53-what-the-server-cancannot-see-published-table-fr-64), [§12 Security Considerations](../falcon-system-design.md#12-security-considerations).

## Encrypted-schema evolution policy

The server can never migrate ciphertext. Every encrypted payload carries a
version; payload schemas are additive-only forever, enforced by CI lint +
golden fixtures per version. A field is never repurposed.

---

**TODO as `@falcon/crypto` lands:** binary layout diagrams (nonce/ciphertext/
tag byte offsets, mirroring Happy's `encryption.md`), primitive choices
confirmed in code (libsodium + WebCrypto AES-GCM), recovery-code
normalization table, and cross-impl (node ↔ web) test vector references.
