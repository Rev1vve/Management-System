import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';
import { SESSION_COOKIE, SessionGuard } from './session.guard';
import { SessionsService } from '../sessions/sessions.service';

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days, aligned with SESSION_TTL_MS
};

export interface LoginBody {
  accountOrEmail: string;
  password: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
  ) {}

  @Post('login')
  async login(@Body() body: LoginBody, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login({
      accountOrEmail: body.accountOrEmail,
      password: body.password,
    });
    res.cookie(SESSION_COOKIE, result.token, COOKIE_OPTIONS);
    return {
      mfaRequired: result.mfaRequired,
      mfaSetupRequired: result.mfaSetupRequired,
    };
  }

  @UseGuards(SessionGuard)
  @Get('me')
  async me(@Req() req: Request) {
    // SessionGuard attaches the user; the login endpoint already set the cookie.
    const { user } = req as unknown as {
      user: {
        id: string;
        account: string;
        name: string;
        workEmail: string;
        status: string;
        mfaEnabled: boolean;
      };
    };
    return user;
  }

  @UseGuards(SessionGuard)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req as { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
    if (token) {
      await this.auth.logout(token);
    }
    res.clearCookie(SESSION_COOKIE, { ...COOKIE_OPTIONS, maxAge: undefined });
    return { ok: true };
  }

  @UseGuards(SessionGuard)
  @Post('logout-all')
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user } = req as unknown as { user: { id: string } };
    await this.sessions.revokeAll(user.id);
    res.clearCookie(SESSION_COOKIE, { ...COOKIE_OPTIONS, maxAge: undefined });
    return { ok: true };
  }
}
