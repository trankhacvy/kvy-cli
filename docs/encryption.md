# Encryption Design

> **Status:** stub — outline + pointers only. Expand this doc as
> `@kvy/crypto` and its consumers actually land. Full detail currently
> lives in [`kvy-system-design.md` §5](../kvy-system-design.md#5-encryption-design-kvycrypto).
>
> **Rule:** this file is updated in the same PR as any crypto change
> (`plan.md` cross-cutting note). If key handling, wrapping, or the trust
> boundary changes and this doc doesn't, the PR is incomplete.

This document will describe how Kvy encrypts data end-to-end, as
implemented in `packages/crypto` (`@kvy/crypto`), and how those encrypted
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

Design doc: [§5.1 Key hierarchy](../kvy-system-design.md#51-key-hierarchy).

## 2. Auth flows

Three flows: web-first sign-up (generate `masterSecret` client-side, derive
keys, OAuth binds identity for recovery/contact), sign-in on a returning
device (ed25519 challenge/response → JWT), and CLI pairing (ephemeral
x25519 keypair, QR/URL handoff, server relays an opaque box it cannot read).

Design doc: [§5.2 Auth flows](../kvy-system-design.md#52-auth-flows).

## 3. What the server can/cannot see

Published table (also required in public security docs, FR-6.4): the
server can see ids, public keys, seq numbers/versions/timestamps, and
routing metadata. It cannot see message/metadata/diff/attachment
plaintext, DEKs, or RPC params/results.

Design doc: [§5.3 What the server can/cannot see](../kvy-system-design.md#53-what-the-server-cancannot-see-published-table-fr-64).

## 4. Trust boundary (honest E2E boundary)

The E2E guarantee is strongest for the **CLI** (installed, checksummed
binary). For the **web app**, encryption protects against DB breach and
passive operator access, but a compromised server could in principle ship
key-exfiltrating JavaScript. Required mitigations: separate origin from the
API, strict CSP, Subresource Integrity, reproducible builds with checksums,
and CLI-as-key-origin as the recommended setup. This caveat must appear
wherever E2E claims are made publicly — never marketed without it.

Design doc: [§5.3 trust boundary](../kvy-system-design.md#53-what-the-server-cancannot-see-published-table-fr-64), [§12 Security Considerations](../kvy-system-design.md#12-security-considerations).

## 5. Identity vs. key custody (issue-4-plan.md, issue #4 rework)

As of the issue-4 auth rework, §2's "Auth flows" above is superseded for
**how you prove who you are** (still evolving separately from **whether you
can decrypt**):

- **Identity (authentication)**: email+password (argon2id, `auth_identities`)
  or OAuth (Google/GitHub), each a real login identity — not derived from
  `masterSecret` anymore. A session is a `device_sessions` row: a rotating
  refresh token (opaque, hashed server-side, 60-day absolute lifetime) mints
  short-lived access tokens (15 minutes) carrying `sid`/`ct` claims. Refresh
  rotation tracks one level of lineage (`previousRefreshTokenHash` +
  `previousRotatedAt`) — a stale token replayed outside a 60s grace window
  revokes the whole session family (theft detection), inside the window is
  tolerated as a benign multi-tab race.
- **Key custody (encryption)**: `masterSecret` still never leaves a client
  unwrapped, still lives only in `signPublicKey`/`contentPubKey` derived from
  it. `accounts.keyEpoch` makes the bound key **rotatable**: losing every
  device holding the PIN/masterSecret is recoverable by starting a new epoch
  (destructive — old data becomes "archived, previous key," not lost/broken)
  rather than losing the account entirely. Every DEK-bearing row
  (`machines`/`sessions`/`workspaces`) is tagged with the epoch its `dek` was
  wrapped under, so a client can render "archived" instead of erroring on an
  old-epoch row.
- **PIN honesty**: the client-side PIN (`@kvy/crypto`'s `pin.ts`/
  `pin.web.ts`, argon2id + AES-256-GCM, identical KDF params both platforms)
  protects `masterSecret` at rest against **casual/opportunistic** access to
  a lost or shared device. It is **not** a defense against a determined
  offline attacker — an attacker holding the device has the encrypted blob
  and can brute-force the PIN at KDF speed with no server involved (and no
  server involvement is deliberate: uploading the PIN would make it
  server-brute-forceable instead, worse). A longer alphanumeric passphrase is
  the honest recommendation for anyone who wants more than "casual access"
  protection; never imply a short PIN plus an attempt counter makes it
  strong — a local attacker fully controls whether that counter is honored.
- **Daemon custody is weaker by necessity**: a headless, self-starting daemon
  cannot prompt a human for a PIN, so its default posture is a
  reduced-custody **content bundle** (can decrypt session data, cannot mint
  new pairings or derive the signing key) rather than the full
  `masterSecret` — smaller blast radius on a compromised dev box. On the
  primary target (headless Linux over SSH) there is usually no unlocked OS
  keyring to wrap it with either, so the honest fallback is the same 0600
  file this codebase has always used — this phase delivers little
  additional at-rest protection on daemon boxes specifically. **As shipped**
  (see docs/issue-4-plan.md's Phase 5 notes): the CLI's PIN-wrap and
  OS-keychain device-key wrap were not implemented in this pass —
  `~/.kvy/access.key` still stores `masterSecretOrContentBundle` as a
  bare base64 string, 0600-permissioned, the same at-rest posture as before.
  What changed is the *credential* alongside it: a rotating refresh token
  instead of a fixed 1h/15m access token, which is what actually fixes a
  daemon "silently dying" after its token expired.
- **Revocation**: immediate on a live WebSocket (the connect handshake and an
  in-band `renew-token` both check the `device_sessions` row; a revoke
  disconnects any live socket for that session right away). Bounded by the
  access token's own TTL (now 15 minutes, down from 1 hour) on plain HTTP,
  since access tokens are stateless by design (no per-request DB hit).

Design doc: [§5.2 Auth flows](../kvy-system-design.md#52-auth-flows) still
describes the pre-issue-4 shape; `docs/issue-4-plan.md` is the current
source of truth for the identity/session layer until kvy-system-design.md
itself is updated (tracked as a follow-up, not done in this pass).

## Encrypted-schema evolution policy

The server can never migrate ciphertext. Every encrypted payload carries a
version; payload schemas are additive-only forever, enforced by CI lint +
golden fixtures per version. A field is never repurposed.

---

**TODO as `@kvy/crypto` lands:** binary layout diagrams (nonce/ciphertext/
tag byte offsets, mirroring Happy's `encryption.md`), primitive choices
confirmed in code (libsodium + WebCrypto AES-GCM), recovery-code
normalization table, and cross-impl (node ↔ web) test vector references.
