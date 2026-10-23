import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports/misc-ports';
import type { OutboxMessage } from '../../domain/outbox/outbox-message';

/**
 * Destino dos eventos de integração: `wager-events.fifo`.
 * `MessageGroupId = aggregateId` (ordenação por agregado) e
 * `MessageDeduplicationId = eventId` (dedup nativa de 5min — duplicata segura).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const attributes: Record<string, { DataType: string; StringValue: string }> = {
      eventType: { DataType: 'String', StringValue: message.eventType },
    };
    const traceparent = message.traceContext?.traceparent;
    if (traceparent) {
      attributes.traceparent = { DataType: 'String', StringValue: traceparent };
      if (message.traceContext?.tracestate) {
        attributes.tracestate = {
          DataType: 'String',
          StringValue: message.traceContext.tracestate,
        };
      }
    }

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: attributes,
      }),
    );
  }
}
