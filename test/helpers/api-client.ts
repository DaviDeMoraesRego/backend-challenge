export interface ApiResponse<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: T;
  readonly contentType: string;
}

const parse = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export async function api<T = Record<string, unknown>>(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return {
    status: response.status,
    body: (await parse(response)) as T,
    contentType: response.headers.get('content-type') ?? '',
  };
}

export function betBody(props: {
  providerId?: string;
  playerId: string;
  walletId: string;
  externalTransactionId: string;
  kind?: string;
  amount?: string;
  currency?: string;
  referenceExternalTransactionId?: string;
}): Record<string, unknown> {
  return {
    providerId: props.providerId ?? 'provider-a',
    externalTransactionId: props.externalTransactionId,
    playerId: props.playerId,
    walletId: props.walletId,
    roundId: 'round-cluster',
    gameId: 'fortune-chimp',
    kind: props.kind ?? 'BET',
    money: { amount: props.amount ?? '1.00', currency: props.currency ?? 'BRL' },
    ...(props.referenceExternalTransactionId
      ? { referenceExternalTransactionId: props.referenceExternalTransactionId }
      : {}),
  };
}
