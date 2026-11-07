import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { MfaModule } from './modules/mfa/mfa.module';
import { AuditModule } from './modules/audit/audit.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { CustomersModule } from './modules/customers/customers.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PortfoliosModule } from './modules/portfolios/portfolios.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { WorkLogsModule } from './modules/work-logs/work-logs.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    UsersModule,
    SessionsModule,
    MfaModule,
    AuditModule,
    CustomersModule,
    PortfoliosModule,
    ProjectsModule,
    OrdersModule,
    AttachmentsModule,
    WorkLogsModule,
    ApprovalsModule,
    NotificationsModule,
    ReportsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
