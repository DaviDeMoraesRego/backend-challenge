import type { LoggerPort } from '../../src/contexts/wagering/application/ports/misc-ports';

export interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly payload: Record<string, unknown>;
  readonly message?: string;
}

/** Logger de teste que retém registros (usado em OBS-04: ausência de dados sensíveis). */
export class RecordingLogger implements LoggerPort {
  readonly records: LogRecord[] = [];

  private push(
    level: LogRecord['level'],
    payload: Record<string, unknown>,
    message?: string,
  ): void {
    this.records.push({ level, payload, message });
  }

  debug(payload: Record<string, unknown>, message?: string): void {
    this.push('debug', payload, message);
  }

  info(payload: Record<string, unknown>, message?: string): void {
    this.push('info', payload, message);
  }

  warn(payload: Record<string, unknown>, message?: string): void {
    this.push('warn', payload, message);
  }

  error(payload: Record<string, unknown>, message?: string): void {
    this.push('error', payload, message);
  }

  child(): LoggerPort {
    return this;
  }

  reset(): void {
    this.records.length = 0;
  }

  serialize(): string {
    return JSON.stringify(this.records);
  }
}
