-- Add MFA challenge throttling state to users (independent of the
-- password-step counters so the two lockouts cannot cancel each other).
ALTER TABLE "users" ADD COLUMN "mfa_failed_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "mfa_locked_until" TIMESTAMPTZ(3);
