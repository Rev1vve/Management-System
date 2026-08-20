import { Module } from '@nestjs/common';
import { readFileSync } from 'node:fs';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SessionGuard } from './session.guard';
import { SessionsService } from '../sessions/sessions.service';
import { MfaService } from '../mfa/mfa.service';
import { PasswordHashService } from '../../crypto/password-hash.service';
import { MfaCipherService } from '../../crypto/mfa-cipher.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionGuard,
    SessionsService,
    MfaService,
    PasswordHashService,
    {
      provide: MfaCipherService,
      useFactory: () => {
        // The production compose file mounts the key as a secret file
        // (MFA_SECRET_KEY_FILE); local dev may pass MFA_SECRET_KEY directly.
        const key = process.env.MFA_SECRET_KEY ?? '';
        if (key) {
          return new MfaCipherService(key);
        }
        const file = process.env.MFA_SECRET_KEY_FILE;
        if (file) {
          return new MfaCipherService(readFileSync(file, 'utf8').trim());
        }
        return new MfaCipherService('');
      },
    },
  ],
  exports: [AuthService, SessionGuard, SessionsService],
})
export class AuthModule {}
