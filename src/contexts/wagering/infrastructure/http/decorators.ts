import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'wagering:public';
export const REQUIRED_SCOPES = 'wagering:required-scopes';

/** `/health/*` e `/metrics` são abertos (README §9). */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_ROUTE, true);

export const RequiresScope = (...scopes: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPES, scopes);
