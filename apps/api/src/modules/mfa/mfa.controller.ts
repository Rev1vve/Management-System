import { Body, Controller, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { MfaService } from './mfa.service';
import { SESSION_COOKIE, SessionGuard, AllowPendingMfa } from '../auth/session.guard';
import { AuthService } from '../auth/auth.service';
import { SessionsService } from '../sessions/sessions.service';

export interface MfaCodeBody {
  code: string;
}

export interface MfaDisableBody {
  password: string;
  code: string;
}

export interface MfaRotateBody {
  password: string;
  code: string;
}

@Controller('mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
  ) {}

  /** Step two of login: verify a TOTP code and activate the pending session. */
  @Post('verify')
  async verify(@Req() req: Request, @Body() body: MfaCodeBody) {
    const token = this.sessionToken(req);
    const { user } = await this.auth.verifyMfaChallenge(token, body.code);
    return { ok: true, account: user.account };
  }

  /** Step two via a single-use recovery code (lost authenticator). */
  @Post('recovery-login')
  async recoveryLogin(@Req() req: Request, @Body() body: MfaCodeBody) {
    const token = this.sessionToken(req);
    const { user } = await this.auth.verifyRecoveryChallenge(token, body.code);
    return { ok: true, account: user.account };
  }

  /**
   * Begin enrollment: generate a fresh TOTP secret (not yet enabled).
   * The PENDING_MFA session (first login of a privileged account that has
   * not set up TOTP yet) is allowed through by AllowPendingMfa.
   */
  @AllowPendingMfa()
  @UseGuards(SessionGuard)
  @Post('setup')
  async setup(@Req() req: Request) {
    const { user } = req as unknown as { user: { id: string } };
    const enrollment = await this.mfa.enroll(user.id);
    return { secret: enrollment.secret, otpauthUrl: enrollment.otpauthUrl };
  }

  /**
   * Enable MFA after a valid code; returns recovery codes exactly once and
   * upgrades the PENDING_MFA session to ACTIVE (the code just verified is
   * the second factor, so the login can complete).
   */
  @AllowPendingMfa()
  @UseGuards(SessionGuard)
  @Post('enable')
  async enable(@Req() req: Request, @Body() body: MfaCodeBody) {
    const { user } = req as unknown as { user: { id: string } };
    const result = await this.mfa.enable(user.id, body.code);
    const token = (req as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
    if (token) {
      await this.sessions.activatePending(token).catch(() => undefined);
    }
    return { ok: true, recoveryCodes: result.recoveryCodes };
  }

  /** Disable MFA, requiring both the password and a current code. */
  @UseGuards(SessionGuard)
  @Post('disable')
  async disable(@Req() req: Request, @Body() body: MfaDisableBody) {
    const { user } = req as unknown as { user: { id: string } };
    await this.mfa.disable(user.id, body.password, body.code);
    return { ok: true };
  }

  /** Rotate recovery codes, requiring password + current code (re-auth). */
  @UseGuards(SessionGuard)
  @Post('recovery-rotate')
  async rotateRecovery(@Req() req: Request, @Body() body: MfaRotateBody) {
    const { user } = req as unknown as { user: { id: string } };
    const recoveryCodes = await this.mfa.rotateRecoveryCodes(user.id, body.password, body.code);
    return { ok: true, recoveryCodes };
  }

  private sessionToken(req: Request): string {
    const token = (req as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
    if (!token) {
      throw new UnauthorizedException('请先登录');
    }
    return token;
  }
}
