import { z } from 'zod';
import { BadRequestError } from '../errors';

/**
 * Validação por zod com `.strict()` (rejeita campos desconhecidos).
 * Única porta de validação de entrada: `safeParse` já devolve `z.output<S>`,
 * então não há cast de retorno.
 */
export function validateWith<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    const unsupported = issues.some((issue) => issue.message === 'UNSUPPORTED_CURRENCY');
    throw new BadRequestError(
      unsupported ? 'UNSUPPORTED_CURRENCY' : 'VALIDATION_FAILED',
      issues.map((issue) => `${issue.path || '(body)'}: ${issue.message}`).join('; '),
      issues,
    );
  }
  return result.data;
}
