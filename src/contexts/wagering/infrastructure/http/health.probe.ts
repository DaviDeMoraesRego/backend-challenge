import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/core';
import type {
  HealthProbeResult,
  ReadinessProbe,
} from '../../application/ports/misc-ports';

const withTimeout = async <T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs),
    ),
  ]);

/** Readiness = PostgreSQL alcançável (`SELECT 1`) e SQS alcançável (GetQueueAttributes). */
export class ReadinessProbeImpl implements ReadinessProbe {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly timeoutMs = 1000,
  ) {}

  async check(): Promise<HealthProbeResult> {
    let pg: 'up' | 'down' = 'down';
    try {
      await withTimeout(
        this.orm.em.fork().getConnection().execute('SELECT 1', [], 'all'),
        this.timeoutMs,
      );
      pg = 'up';
    } catch {
      pg = 'down';
    }

    let sqs: 'up' | 'down' = 'down';
    try {
      await withTimeout(
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.queueUrl,
            AttributeNames: ['QueueArn'],
          }),
        ),
        this.timeoutMs,
      );
      sqs = 'up';
    } catch {
      sqs = 'down';
    }

    return { pg, sqs };
  }
}
