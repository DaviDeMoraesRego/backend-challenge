import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { CoreModule } from './core.module';
import { HttpApiModule } from './http-api.module';
import { WageringDomainWiringModule } from './wagering-domain-wiring.module';
import type { RuntimeDependencies } from './runtime-dependencies';
import { RequestContextMiddleware } from '../contexts/wagering/infrastructure/http/middleware/request-context.middleware';
import type { RolePlan } from '../roles';

/**
 * Um único binário, papéis por env: só monta controllers de negócio quando o papel
 * `api` está habilitado; health/metrics existem sempre (readiness do harness).
 */
@Module({})
export class AppModule implements NestModule {
  static forBootstrap(deps: RuntimeDependencies, plan: RolePlan): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(deps),
        WageringDomainWiringModule.forRoot(),
        HttpApiModule.forRoot({ business: plan.http }),
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
