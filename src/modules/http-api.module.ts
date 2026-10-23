import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { WalletController } from '../contexts/wagering/infrastructure/http/controllers/wallet.controller';
import { WageringController } from '../contexts/wagering/infrastructure/http/controllers/wagering.controller';
import { HealthController } from '../contexts/wagering/infrastructure/http/controllers/health.controller';
import { MetricsController } from '../contexts/wagering/infrastructure/observability/metrics/metrics.controller';
import { ProblemDetailsFilter } from '../contexts/wagering/infrastructure/http/filters/problem-details.filter';
import { AuthGuard } from '../contexts/wagering/infrastructure/http/guards/auth.guard';
import { TelemetryInterceptor } from '../contexts/wagering/infrastructure/http/interceptors/telemetry.interceptor';

/** Ordem global: Guard (auth) → Interceptor (telemetria) → Pipe (zod) → Controller. */
@Module({})
export class HttpApiModule {
  static forRoot(options: { business: boolean }): DynamicModule {
    return {
      module: HttpApiModule,
      controllers: [
        ...(options.business ? [WalletController, WageringController] : []),
        HealthController,
        MetricsController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_INTERCEPTOR, useClass: TelemetryInterceptor },
      ],
    };
  }
}
