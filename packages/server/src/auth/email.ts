import type { FastifyBaseLogger } from "fastify";

// issue-4-plan.md Phase 0 decision + §5.3/§5.4: transactional email (verify + reset) sits
// behind this small interface so the register/reset routes never depend on a concrete
// provider. The default transport just logs the link — makes the whole flow testable
// (and self-hostable with zero config) without real SMTP. A real provider becomes
// pluggable later by constructing a different `EmailTransport` and passing it into the
// route factories, the same injection pattern every other route dependency in this
// package already uses (db, eventRouter, pushDispatcher, …).
export interface VerificationEmailParams {
  to: string;
  verifyUrl: string;
}

export interface ResetEmailParams {
  to: string;
  resetUrl: string;
}

export interface EmailTransport {
  sendVerificationEmail(params: VerificationEmailParams): Promise<void>;
  sendResetEmail(params: ResetEmailParams): Promise<void>;
}

/**
 * Default transport: logs the link at `info` level instead of sending anything. Safe for
 * local dev and for a self-host box with no mail provider configured — see §5.3 ("if a
 * self-host box has no email configured, password reset is disabled and the UI says so").
 * `SMTP_URL`/provider API keys are the intended real-transport config surface but no real
 * transport is wired up yet — the request this default logs is exactly what a real
 * transport would need to send.
 */
export function createDevLoggerEmailTransport(logger: FastifyBaseLogger): EmailTransport {
  return {
    async sendVerificationEmail({ to, verifyUrl }) {
      logger.info(
        { module: "auth-email", to, verifyUrl },
        "[dev email transport] verification email (not sent — no SMTP configured)",
      );
    },
    async sendResetEmail({ to, resetUrl }) {
      logger.info(
        { module: "auth-email", to, resetUrl },
        "[dev email transport] password reset email (not sent — no SMTP configured)",
      );
    },
  };
}
