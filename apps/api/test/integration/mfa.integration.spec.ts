import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../../src/database/prisma.service';
import { PasswordHashService } from '../../src/crypto/password-hash.service';
import { MfaCipherService } from '../../src/crypto/mfa-cipher.service';
import { sha256Hex } from '../../src/crypto/token.util';
import { MfaService } from '../../src/modules/mfa/mfa.service';

/**
 * Integration tests for TOTP enrollment, verification, enabling, recovery
 * codes (single-use, hashed, rotated) and MFA disable requiring both the
 * password and a current code. Requires a real PostgreSQL on the private
 * Compose network.
 */
const prisma = new PrismaService();

// Test-only MFA key (64 hex chars = 32 bytes). Never used in production.
const TEST_MFA_KEY = 'b'.repeat(64);

const TABLES = [
  'audit_logs',
  'notifications',
  'email_outbox',
  'mfa_recovery_codes',
  'sessions',
  'invitations',
  'user_system_roles',
  'system_roles',
  'users',
];

async function truncateAll(): Promise<void> {
  const joined = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${joined} RESTART IDENTITY CASCADE`);
}

const passwordHash = new PasswordHashService();
let mfaService: MfaService;

beforeAll(async () => {
  mfaService = new MfaService(prisma, passwordHash, new MfaCipherService(TEST_MFA_KEY));
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createActiveUser(): Promise<{ id: string; password: string }> {
  const password = 'correct horse battery staple';
  const user = await prisma.user.create({
    data: {
      account: 'mfa-user',
      name: 'MFA 用户',
      workEmail: 'mfa-user@example.test',
      status: 'ACTIVE',
      passwordHash: await passwordHash.hash(password),
    },
  });
  return { id: user.id, password };
}

function currentCode(secret: string): string {
  return generateSync({ secret });
}

describe('MfaService', () => {
  it('enrolls by generating a secret and storing only its ciphertext', async () => {
    const { id } = await createActiveUser();
    const enrollment = await mfaService.enroll(id);

    expect(enrollment.secret).toMatch(/^[A-Z2-7]+={0,2}$/); // base32
    expect(enrollment.otpauthUrl).toContain('otpauth://totp/');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(stored.mfaSecretCiphertext).not.toBeNull();
    expect(stored.mfaSecretCiphertext).not.toContain(enrollment.secret);
    expect(stored.mfaEnabled).toBe(false);
  });

  it('verifies a valid TOTP code and rejects a wrong one', async () => {
    const { id } = await createActiveUser();
    const { secret } = await mfaService.enroll(id);

    const code = currentCode(secret);
    await expect(mfaService.verifyCode(id, code)).resolves.toBe(true);
    await expect(mfaService.verifyCode(id, '000000')).resolves.toBe(false);
  });

  it('enables MFA after a valid code and returns single-use recovery codes', async () => {
    const { id } = await createActiveUser();
    const { secret } = await mfaService.enroll(id);

    const result = await mfaService.enable(id, currentCode(secret));

    expect(result.recoveryCodes).toHaveLength(10);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(stored.mfaEnabled).toBe(true);

    // Only hashes are stored.
    const codes = await prisma.mfaRecoveryCode.findMany({ where: { userId: id } });
    expect(codes).toHaveLength(10);
    for (const code of result.recoveryCodes) {
      expect(codes.map((c) => c.codeHash)).toContain(sha256Hex(code));
      expect(codes.map((c) => c.codeHash)).not.toContain(code);
    }
  });

  it('rejects enabling MFA with a wrong code', async () => {
    const { id } = await createActiveUser();
    await mfaService.enroll(id);
    await expect(mfaService.enable(id, '123456')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('consumes a recovery code exactly once', async () => {
    const { id } = await createActiveUser();
    const { secret } = await mfaService.enroll(id);
    const { recoveryCodes } = await mfaService.enable(id, currentCode(secret));

    const code = recoveryCodes[0]!;
    await expect(mfaService.verifyRecoveryCode(id, code)).resolves.toBe(true);
    // Second use of the same code fails.
    await expect(mfaService.verifyRecoveryCode(id, code)).resolves.toBe(false);

    const stored = await prisma.mfaRecoveryCode.findFirst({
      where: { userId: id, codeHash: sha256Hex(code) },
    });
    expect(stored?.usedAt).not.toBeNull();
  });

  it('rejects an unknown recovery code', async () => {
    const { id } = await createActiveUser();
    await expect(mfaService.verifyRecoveryCode(id, 'no-such-code')).resolves.toBe(false);
  });

  it('rotates recovery codes, invalidating the old set', async () => {
    const { id, password } = await createActiveUser();
    const { secret } = await mfaService.enroll(id);
    const { recoveryCodes } = await mfaService.enable(id, currentCode(secret));

    const rotated = await mfaService.rotateRecoveryCodes(id, password, currentCode(secret));
    expect(rotated).toHaveLength(10);
    expect(rotated).not.toContain(recoveryCodes[0]!);

    await expect(mfaService.verifyRecoveryCode(id, recoveryCodes[0]!)).resolves.toBe(false);
  });

  it('rejects enrolling again once MFA is already enabled (factor takeover defence)', async () => {
    const { id } = await createActiveUser();
    const { secret } = await mfaService.enroll(id);
    await mfaService.enable(id, currentCode(secret));

    await expect(mfaService.enroll(id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects enabling again once MFA is already enabled', async () => {
    const { id } = await createActiveUser();
    const { secret } = await mfaService.enroll(id);
    await mfaService.enable(id, currentCode(secret));

    await expect(mfaService.enable(id, currentCode(secret))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rotates recovery codes only with the password and a current code', async () => {
    const { id, password } = await createActiveUser();
    const { secret } = await mfaService.enroll(id);
    await mfaService.enable(id, currentCode(secret));

    // Wrong password is rejected.
    await expect(
      mfaService.rotateRecoveryCodes(id, 'wrong password here', currentCode(secret)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Correct password + wrong code is rejected.
    await expect(mfaService.rotateRecoveryCodes(id, password, '123456')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('disables MFA only with the password and a current code', async () => {
    const { id, password } = await createActiveUser();
    const { secret } = await mfaService.enroll(id);
    await mfaService.enable(id, currentCode(secret));

    // Wrong password is rejected before checking the code.
    await expect(
      mfaService.disable(id, 'wrong password here', currentCode(secret)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Correct password + wrong code is rejected.
    await expect(mfaService.disable(id, password, '123456')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // Correct password + correct code disables MFA and clears the secret.
    await mfaService.disable(id, password, currentCode(secret));
    const stored = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(stored.mfaEnabled).toBe(false);
    expect(stored.mfaSecretCiphertext).toBeNull();
  });
});
