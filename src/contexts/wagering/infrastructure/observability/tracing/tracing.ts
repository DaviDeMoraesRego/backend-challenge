import {
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Span,
} from '@opentelemetry/api';
import type { SpanHandle, Tracer } from '../../../application/ports/misc-ports';
import type { TraceContext } from '../../../domain/outbox/outbox-message';
import { requestContext } from '../als/request-context';

const isSpanAttribute = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const spanHandle = (span: Span): SpanHandle => ({
  setAttribute: (key, value) => span.setAttribute(key, value),
  setAttributes: (attributes) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (!isSpanAttribute(value)) continue;
      span.setAttribute(key, value);
    }
  },
  recordError: (error) => {
    if (error instanceof Error) span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
  },
});

const patchContext = (span: Span): void => {
  const spanContext = span.spanContext();
  requestContext.patch({ traceId: spanContext.traceId, spanId: spanContext.spanId });
};

/** Instrumentação manual (ADR-10): fallback pré-decidido para o runtime Bun. */
export class OtelTracer implements Tracer {
  private readonly tracer = trace.getTracer('wagering-api');

  async withSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      const handle = spanHandle(span);
      handle.setAttributes(attributes);
      patchContext(span);
      try {
        return await fn(handle);
      } catch (error) {
        handle.recordError(error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async withRemoteSpan<T>(
    remote: TraceContext | null,
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    if (!remote?.traceparent) return this.withSpan(name, attributes, fn);
    const carrier: Record<string, string> = { traceparent: remote.traceparent };
    if (remote.tracestate) carrier.tracestate = remote.tracestate;
    const parent = propagation.extract(context.active(), carrier);
    return context.with(parent, () => this.withSpan(name, attributes, fn));
  }

  injectTraceContext(): TraceContext | null {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    const traceparent = carrier.traceparent;
    if (!traceparent) return null;
    return { traceparent, tracestate: carrier.tracestate };
  }
}

/** No-op usado quando OTEL_ENABLED=false (mantém o mesmo contrato). */
export class NoopTracer implements Tracer {
  async withSpan<T>(
    _name: string,
    _attributes: Record<string, unknown>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    return fn({
      setAttribute: () => undefined,
      setAttributes: () => undefined,
      recordError: () => undefined,
    });
  }

  async withRemoteSpan<T>(
    _remote: TraceContext | null,
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    return this.withSpan(name, attributes, fn);
  }

  injectTraceContext(): TraceContext | null {
    return null;
  }
}

export interface TracingRuntime {
  readonly tracer: Tracer;
  shutdown(): Promise<void>;
}

export async function setupTracing(options: {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  role: string;
  instanceId: string;
}): Promise<TracingRuntime> {
  if (!options.enabled) {
    return { tracer: new NoopTracer(), shutdown: async () => undefined };
  }
  try {
    const [{ NodeTracerProvider }, { BatchSpanProcessor }, { OTLPTraceExporter }, { Resource }] =
      await Promise.all([
        import('@opentelemetry/sdk-trace-node'),
        import('@opentelemetry/sdk-trace-base'),
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/resources'),
      ]);

    const provider = new NodeTracerProvider({
      resource: new Resource({
        'service.name': options.serviceName,
        'service.instance.id': options.instanceId,
        'deployment.role': options.role,
      }),
    });
    provider.addSpanProcessor(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` }),
      ),
    );
    provider.register();
    return {
      tracer: new OtelTracer(),
      shutdown: async () => {
        await provider.shutdown();
      },
    };
  } catch (error) {
    // Fallback documentado (ADR-10): instrumentação manual permanece funcional.
    console.warn(
      'OTel indisponível neste runtime — seguindo com tracer no-op',
      error instanceof Error ? error.message : error,
    );
    return { tracer: new NoopTracer(), shutdown: async () => undefined };
  }
}
