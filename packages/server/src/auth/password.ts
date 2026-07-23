import { hash, verify } from "@node-rs/argon2";

// issue-4-plan.md §5.1: argon2id password hashing for email/password identities. `hash`
// returns a self-describing PHC string (salt + params embedded), so `verify` needs no
// separately-stored parameters — the same shape bcrypt/argon2 libraries have used for
// years, and what `auth_identities.passwordHash` stores.
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export function verifyPassword(phc: string, password: string): Promise<boolean> {
  return verify(phc, password);
}
