import {
  Injectable,
  CanActivate,
  ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { SessionsService } from '../sessions/sessions.service';
import type { User } from '../../generated/prisma/client';

export const SESSION_COOKIE = 'poc_session';
export const CSRF_HEADER = 'x-requested-with';
/** Set on an endpoint to let a PENDING_MFA session through (MFA setup only). */
export const ALLOW_PENDING_MFA = 'allowPendingMfa';
export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA, true);

export interface AuthenticatedRequest extends Request {
  user: User;
  sessionId: string;
}

/**
 * Reads the session cookie, validates it via SessionsService and attaches the
 * authenticated user to the request. Also enforces a custom header on
 * mutating requests as a CSRF defence-in-depth layer on top of SameSite=Lax.
 *
 * Fail-closed: any missing/invalid/expired session yields 401.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('请先登录');
    }
    const allowPendingMfa =
      this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_MFA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    const { user, session } = await this.sessions.validate(token, { allowPendingMfa });
    request.user = user;
    request.sessionId = session.id;

    // CSRF defence-in-depth: mutating methods require the custom header.
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const header = request.headers[CSRF_HEADER];
      if (header !== 'XMLHttpRequest') {
        throw new UnauthorizedException('请求缺少 CSRF 防护头');
      }
    }
    return true;
  }
}
