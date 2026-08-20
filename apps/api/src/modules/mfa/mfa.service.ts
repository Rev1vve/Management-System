import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';

import { PrismaService } from '../../database/prisma.service';
import { PasswordHashService } from '../../crypto/password-hash.service';
import { MfaCipherService } from '../../crypto/mfa-cipher.service';
import { randomToken, sha256Hex } from '../../crypto/token.util';
import type { Prisma } from '../../generated/prisma/client';

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_BYTES = 16;
// Allow ±1 time step (30 s each) for clock drift between authenticator and server.
const TOTP_EPOCH_TOLERANCE = 1;

/**
 * TOTP multi-factor authentication (plan section 20, task 5):
 * - Enrollment generates a Base32 secret; only its AES-256-GCM ciphertext is
 *   stored (plaintext never persisted or logged). Enrolling again while MFA
 *   is enabled is rejected so a session holder cannot silently replace the
 *   factor (factor takeover defence).
 * - Verification uses otplib's constant-time compare with a ±1 step window.
 * - Enabling returns 10 recovery codes exactly once; only SHA-256 hashes are
 *   stored, each code is single-use, and rotation invalidates the old set.
 *   Rotation and disabling require the current password plus a valid TOTP
 *   code (re-authentication of factor management, per the security review).
 * - The recovery-code consumption transaction is supplied by the caller so
 *   the code is only burned when the session upgrade also succeeds.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHash: PasswordHashService,
    private readonly cipher: MfaCipherService,
  ) {}

  async enroll(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (user.mfaEnabled) {
      throw new ConflictException('MFA 已启用，请先禁用后再重新设置');
    }
    const secret = generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecretCiphertext: this.cipher.encrypt(secret) },
    });
    const otpauthUrl = generateURI({
      issuer: 'Project Operations Center',
      label: user.workEmail,
      secret,
    });
    return { secret, otpauthUrl };
  }

  async verifyCode(userId: string, code: string): Promise<boolean> {
    const secret = await this.decryptSecret(userId);
    if (!secret) {
      return false;
    }
    const result = await verifyTotp({
      secret,
      token: code.trim(),
      epochTolerance: TOTP_EPOCH_TOLERANCE,
    });
    return result.valid;
  }

  async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaEnabled: true },
    });
    if (user.mfaEnabled) {
      throw new ConflictException('MFA 已启用，请先禁用后再重新设置');
    }
    const verified = await this.verifyCode(userId, code);
    if (!verified) {
      throw new BadRequestException('验证码不正确');
    }

    const recoveryCodes = await this.generateRecoveryCodes(userId);

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true },
    });

    return { recoveryCodes };
  }

  /**
   * Consumes a recovery code inside the caller's transaction (the caller
   * upgrades the session in the same transaction so a failed upgrade never
   * burns a code). Pass `tx` for the interactive transaction client.
   */
  async verifyRecoveryCode(
    userId: string,
    code: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.prisma;
    const codeHash = sha256Hex(code.trim());
    const match = await client.mfaRecoveryCode.findFirst({
      where: { userId, codeHash, usedAt: null },
    });
    if (!match) {
      return false;
    }
    await client.mfaRecoveryCode.update({
      where: { id: match.id },
      data: { usedAt: new Date() },
    });
    return true;
  }

  /**
   * Rotates the recovery-code set. Requires the current password plus a
   * valid TOTP code (re-authentication) so a stolen session alone cannot
   * take over the MFA factor.
   */
  async rotateRecoveryCodes(userId: string, password: string, code: string): Promise<string[]> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.mfaEnabled) {
      throw new ConflictException('MFA 未启用');
    }
    const passwordOk = await this.passwordHash.verify(password, user.passwordHash ?? '');
    if (!passwordOk) {
      throw new UnauthorizedException('密码不正确');
    }
    const verified = await this.verifyCode(userId, code);
    if (!verified) {
      throw new BadRequestException('验证码不正确');
    }

    await this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } });
    return this.generateRecoveryCodes(userId);
  }

  async disable(userId: string, password: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const passwordOk = await this.passwordHash.verify(password, user.passwordHash ?? '');
    if (!passwordOk) {
      throw new UnauthorizedException('密码不正确');
    }
    const verified = await this.verifyCode(userId, code);
    if (!verified) {
      throw new BadRequestException('验证码不正确');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { mfaEnabled: false, mfaSecretCiphertext: null },
      }),
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    ]);
  }

  private async decryptSecret(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.mfaSecretCiphertext) {
      return null;
    }
    try {
      return this.cipher.decrypt(user.mfaSecretCiphertext);
    } catch {
      return null;
    }
  }

  private async generateRecoveryCodes(userId: string): Promise<string[]> {
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
      const code = randomToken(RECOVERY_CODE_BYTES);
      codes.push(code);
      await this.prisma.mfaRecoveryCode.create({
        data: { userId, codeHash: sha256Hex(code) },
      });
    }
    return codes;
  }
}
