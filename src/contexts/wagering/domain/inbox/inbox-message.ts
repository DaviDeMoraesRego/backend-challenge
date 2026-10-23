export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date;
}

/** Inbox persistente por `(consumerName, messageId)` — dedup de redelivery. */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    this._processedAt = at;
  }
}
