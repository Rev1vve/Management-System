import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

export interface AuditRecordInput {
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  result: string;
  summary?: string | null;
  /** Set false only for summaries already proven safe (no secrets inside). */
  redactSensitive?: boolean;
}

/**
 * Writes the application audit trail (plan line 401): actor, action, resource,
 * project scope, result and a redacted summary. By default the summary is
 * scanned for sensitive material — passwords, tokens, TOTP secrets and
 * recovery codes — and replaced with `[REDACTED]`; callers must explicitly opt
 * out with `redactSensitive: false` for summaries they control.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    const redact = input.redactSensitive !== false;
    await this.prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        projectId: input.projectId ?? null,
        result: input.result,
        summary: redact ? redactSummary(input.summary ?? null) : (input.summary ?? null),
      },
    });
  }
}

/**
 * Replaces anything that looks like a secret value with `[REDACTED]`.
 * The pattern matches the sensitive keyword plus up to 120 characters of the
 * value that follows it (word separators, `:`/`=` or whitespace).
 */
function redactSummary(summary: string | null): string | null {
  if (!summary) {
    return summary;
  }
  return summary.replace(
    /(?:password|passwd|token|secret|recovery\s*code|totp|mfa\s*secret)[^\n]{0,120}/gi,
    '[REDACTED]',
  );
}
