-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('PENDING_MFA', 'ACTIVE');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "last_used_at" TIMESTAMPTZ(3),
ADD COLUMN     "status" "SessionStatus" NOT NULL DEFAULT 'PENDING_MFA';

-- AlterTable
ALTER TABLE "system_roles" ADD COLUMN     "requires_mfa" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMPTZ(3),
ADD COLUMN     "mfa_secret_ciphertext" TEXT;

-- CreateIndex
CREATE INDEX "sessions_status_idx" ON "sessions"("status");
