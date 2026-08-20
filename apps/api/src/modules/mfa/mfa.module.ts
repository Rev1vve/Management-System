import { Module } from '@nestjs/common';
import { readFileSync } from 'node:fs';

import { MfaService } from './mfa.service';
import { MfaController } from './mfa.controller';
import { AuthService } from '../auth/auth.service';
import { SessionsService } from '../sessions/sessions.service';
import { PasswordHashService } from '../../crypto/password-hash.service';
import { MfaCipherService } from '../../crypto/mfa-cipher.service';

@Module({
  controllers: [MfaController],
  providers: [
    MfaService,
    AuthService,
    SessionsService,
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
  exports: [MfaService],
})
export class MfaModule {}
