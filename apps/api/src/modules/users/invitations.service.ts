import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { PasswordHashService } from '../../crypto/password-hash.service';
import { randomToken, sha256Hex } from '../../crypto/token.util';
import type { Invitation, User } from '../../generated/prisma/client';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateInvitationInput {
  actorId: string;
  email: string;
}

export interface AcceptInvitationInput {
  token: string;
  name: string;
  password: string;
}

/**
 * Invitation lifecycle (task 5, plan section 20):
 * - Users with the `user:invite` permission create short-lived, single-use
 *   invitations; only the SHA-256 digest of the token is stored and the
 *   activation link is enqueued in EmailOutbox.
 * - Activation consumes the invitation exactly once: it sets the password,
 *   activates the user and marks the invitation ACCEPTED. Replay, expiry and
 *   unknown tokens all fail closed with 410 Gone.
 *
 * Permission enforcement lives in the HTTP guard layer (task 6); this
 * service only implements the invitation mechanics.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHash: PasswordHashService,
  ) {}

  async createInvitation(
    input: CreateInvitationInput,
  ): Promise<{ token: string; invitation: Invitation }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: input.actorId },
    });
    if (!actor || actor.status !== 'ACTIVE') {
      throw new NotFoundException('操作者不存在或未激活');
    }

    const [existingUser, existingInvitation] = await Promise.all([
      this.prisma.user.findUnique({ where: { workEmail: email } }),
      this.prisma.invitation.findFirst({
        where: { email, status: 'PENDING' },
      }),
    ]);
    if (existingUser) {
      throw new ConflictException('该邮箱已有账号');
    }
    if (existingInvitation) {
      throw new ConflictException('该邮箱已有待处理的邀请');
    }

    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const invitation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invitation.create({
        data: {
          email,
          tokenHash: sha256Hex(token),
          expiresAt,
          createdById: input.actorId,
        },
      });
      await tx.emailOutbox.create({
        data: {
          toAddress: email,
          subject: '项目运营中心：账号激活邀请',
          body: `欢迎加入项目运营中心。请在 7 天内完成激活：${activationLink(token)}`,
        },
      });
      return created;
    });

    return { token, invitation };
  }

  async acceptInvitation(input: AcceptInvitationInput): Promise<User> {
    const tokenHash = sha256Hex(input.token.trim());
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash },
    });
    if (!invitation || invitation.status !== 'PENDING') {
      // Unknown, already consumed or revoked tokens are indistinguishable.
      throw new GoneException('邀请链接无效或已被使用');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new GoneException('邀请链接已过期');
    }

    let passwordHash: string;
    try {
      passwordHash = await this.passwordHash.hash(input.password);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '密码不符合要求');
    }

    const email = invitation.email;
    const account = await this.deriveUniqueAccount(email);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          account,
          name: input.name.trim(),
          workEmail: email,
          status: 'ACTIVE',
          passwordHash,
        },
      });
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
      return created;
    });

    return user;
  }

  private async deriveUniqueAccount(email: string): Promise<string> {
    // Email is validated by EMAIL_PATTERN before storage, so the local part
    // always exists; `?? email` satisfies strict TypeScript narrowing.
    const local = email.split('@')[0] ?? email;
    const existing = await this.prisma.user.findUnique({
      where: { account: local },
    });
    if (!existing) {
      return local;
    }
    // The full email is unique because work_email is unique.
    return email;
  }
}

function activationLink(token: string): string {
  const baseUrl = process.env.WEB_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000';
  return `${baseUrl}/invite/accept?token=${encodeURIComponent(token)}`;
}
