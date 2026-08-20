import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { MfaModule } from './modules/mfa/mfa.module';
import { AuditModule } from './modules/audit/audit.module';

@Module({
  imports: [DatabaseModule, AuthModule, UsersModule, SessionsModule, MfaModule, AuditModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
