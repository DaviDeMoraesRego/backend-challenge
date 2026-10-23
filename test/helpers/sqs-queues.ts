import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

export interface QueueDepth {
  readonly visible: number;
  readonly inFlight: number;
}

export interface RedrivenQueues {
  readonly url: string;
  readonly dlqUrl: string;
}

/**
 * Filas efêmeras por suíte: os testes de mensageria precisam de atributos próprios
 * (redrive curto, lease curto) sem interferir nas filas do compose.
 */
export class TestQueues {
  private readonly created = new Set<string>();

  constructor(private readonly sqs: SQSClient) {}

  async ensure(
    name: string,
    attributes: Record<string, string> = {},
  ): Promise<string> {
    const response = await this.sqs.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          ...attributes,
        },
      }),
    );
    this.created.add(name);
    return response.QueueUrl as string;
  }

  /** Par fila+DLQ com redrive nativo (`maxReceiveCount`). */
  async ensureWithRedrive(
    name: string,
    dlqName: string,
    maxReceiveCount: number,
  ): Promise<RedrivenQueues> {
    const dlqUrl = await this.ensure(dlqName, { MessageRetentionPeriod: '1209600' });
    const dlqArn = await this.arn(dlqUrl);
    const url = await this.ensure(name, {
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: String(maxReceiveCount),
      }),
      VisibilityTimeout: '5',
    });
    return { url, dlqUrl };
  }

  async arn(url: string): Promise<string> {
    const response = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['QueueArn'],
      }),
    );
    return response.Attributes?.QueueArn as string;
  }

  async depth(url: string): Promise<QueueDepth> {
    const response = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }),
    );
    return {
      visible: Number(response.Attributes?.ApproximateNumberOfMessages ?? '0'),
      inFlight: Number(
        response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0',
      ),
    };
  }

  async receive(
    url: string,
    options: { max?: number; waitSeconds?: number; visibilityTimeout?: number } = {},
  ): Promise<Message[]> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: options.max ?? 10,
        WaitTimeSeconds: options.waitSeconds ?? 0,
        VisibilityTimeout: options.visibilityTimeout ?? 0,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    return response.Messages ?? [];
  }

  async deleteMessage(url: string, message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: url,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  /** Esvazia a fila (devolvendo a visibilidade) para asserções determinísticas. */
  async drain(url: string): Promise<void> {
    for (let round = 0; round < 40; round += 1) {
      const messages = await this.receive(url, { max: 10, visibilityTimeout: 0 });
      for (const message of messages) {
        await this.deleteMessage(url, message);
      }
      if (messages.length < 10) return;
    }
  }

  /** Consome tudo e devolve os corpos (JSON já parseado quando possível). */
  async consumeAll(url: string, rounds = 20): Promise<Array<Record<string, unknown>>> {
    const bodies: Array<Record<string, unknown>> = [];
    for (let round = 0; round < rounds; round += 1) {
      const messages = await this.receive(url, { max: 10, visibilityTimeout: 0 });
      if (messages.length === 0) return bodies;
      for (const message of messages) {
        try {
          bodies.push(JSON.parse(message.Body ?? '{}') as Record<string, unknown>);
        } catch {
          bodies.push({ raw: message.Body });
        }
        await this.deleteMessage(url, message);
      }
      if (messages.length < 10) return bodies;
    }
    return bodies;
  }

  async destroyAll(): Promise<void> {
    for (const name of this.created) {
      try {
        const url = await this.ensure(name);
        await this.sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      } catch {
        // limpeza best-effort
      }
    }
    this.created.clear();
  }
}
