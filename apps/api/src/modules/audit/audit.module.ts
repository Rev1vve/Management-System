import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service';

/**
 * Global audit module: the audit trail is a cross-cutting concern consumed by
 * every feature module (auth, sessions, invitations, MFA), so the service is
 * registered globally instead of being imported per module.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
