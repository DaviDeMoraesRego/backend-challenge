import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';
import { eventually } from './eventually';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(
  /[\\/]+$/,
  '',
);

export interface FaultFlags {
  readonly enabled: boolean;
  readonly crashAfterCommitBeforeAck: boolean;
  readonly crashAfterPublishBeforeMark: boolean;
  readonly crashAfterClaimOutbox: boolean;
}

export interface ClusterInstance {
  readonly index: number;
  readonly port: number;
  readonly instanceId: string;
  readonly url: string;
}

export interface ClusterOptions {
  /** quantos processos reais (default 3 — README §8/§13.3.4). */
  readonly instances?: number;
  readonly basePort?: number;
  readonly role?: string;
  readonly databaseUrl: string;
  readonly sqsEndpoint: string;
  readonly transactionsQueueUrl: string;
  readonly transactionsDlqUrl: string;
  readonly eventsQueueUrl: string;
  readonly fault?: Partial<FaultFlags>;
  readonly env?: Record<string, string>;
  /** env extra por índice (ex.: apenas uma instância com fault injection). */
  readonly envByIndex?: Record<number, Record<string, string>>;
  readonly readyTimeoutMs?: number;
}

const DEFAULT_ROLE =
  'api,sqs-consumer,outbox-publisher,pending-reference-worker,reconciliation-job,outbox-retention-job';

/**
 * Cluster de processos **reais** (`Bun.spawn` + `src/main.ts`): cada instância tem
 * pool, Identity Map, poller e publisher próprios — é o que prova que a correção
 * não depende de estado em memória compartilhada.
 */
export class AppCluster {
  private readonly processes = new Map<number, Subprocess>();
  private readonly logs = new Map<number, string[]>();
  private stopped = false;

  private constructor(
    private readonly options: ClusterOptions,
    private readonly nodes: ClusterInstance[],
  ) {}

  /** Porta ocupada (execução anterior interrompida, outro arquivo de teste…). */
  private static async isBusy(port: number): Promise<boolean> {
    try {
      await fetch(`http://127.0.0.1:${port}/health/live`, {
        signal: AbortSignal.timeout(400),
      });
      return true;
    } catch {
      return false;
    }
  }

  static async start(options: ClusterOptions): Promise<AppCluster> {
    const count = options.instances ?? 3;
    let cursor = options.basePort ?? 3101;
    const ports: number[] = [];
    for (let index = 0; index < count; index += 1) {
      while (await AppCluster.isBusy(cursor)) cursor += 1;
      ports.push(cursor);
      cursor += 1;
    }
    const nodes: ClusterInstance[] = ports.map((port, index) => ({
      index,
      port,
      instanceId: `it-${port}`,
      url: `http://127.0.0.1:${port}`,
    }));

    const cluster = new AppCluster(options, nodes);
    for (const node of nodes) cluster.spawn(node);
    for (const node of nodes) await cluster.waitReady(node);
    return cluster;
  }

  get instances(): readonly ClusterInstance[] {
    return this.nodes;
  }

  urls(): string[] {
    return this.nodes.map((node) => node.url);
  }

  roundRobin(index: number): ClusterInstance {
    return this.nodes[index % this.nodes.length];
  }

  /** Logs das instâncias (diagnóstico quando uma asserção falha). */
  tail(): string {
    return [...this.logs.entries()]
      .map(([index, lines]) => `--- instance ${index} ---\n${lines.join('')}`)
      .join('\n');
  }

  async kill(index: number): Promise<void> {
    const process = this.processes.get(index);
    if (!process) return;
    process.kill('SIGKILL');
    await process.exited.catch(() => undefined);
    this.processes.delete(index);
  }

  async restart(index: number): Promise<void> {
    const node = this.nodes[index];
    this.spawn(node);
    await this.waitReady(node);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await Promise.all(
      [...this.processes.entries()].map(async ([index, process]) => {
        process.kill('SIGTERM');
        const timer = setTimeout(() => process.kill('SIGKILL'), 8_000);
        await process.exited.catch(() => undefined);
        clearTimeout(timer);
        this.processes.delete(index);
      }),
    );
  }

  private spawn(node: ClusterInstance): void {
    const fault: FaultFlags = {
      enabled: false,
      crashAfterCommitBeforeAck: false,
      crashAfterPublishBeforeMark: false,
      crashAfterClaimOutbox: false,
      ...this.options.fault,
    };

    const env: Record<string, string> = {
      ...(Bun.env as Record<string, string>),
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      ROLE: this.options.role ?? DEFAULT_ROLE,
      PORT: String(node.port),
      INSTANCE_ID: node.instanceId,
      DATABASE_URL: this.options.databaseUrl,
      PG_POOL_MAX: '12',
      SQS_ENDPOINT: this.options.sqsEndpoint,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_TRANSACTIONS_QUEUE_URL: this.options.transactionsQueueUrl,
      SQS_TRANSACTIONS_DLQ_URL: this.options.transactionsDlqUrl,
      SQS_EVENTS_QUEUE_URL: this.options.eventsQueueUrl,
      SQS_CONSUMER_CONCURRENCY: '8',
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_REQUIRE_SIGNATURE: 'false',
      SQS_SIGNING_SECRET: '',
      AUTH_ENABLED: 'false',
      METRICS_ENABLED: 'true',
      METRICS_AUTH_TOKEN: '',
      OTEL_ENABLED: 'false',
      SUPPORTED_CURRENCIES: 'BRL,USD',
      PROVIDERS: 'provider-a,provider-b',
      // janelas curtas para os testes de crash/lease não esperarem 30s
      OUTBOX_POLL_MS: '150',
      OUTBOX_BATCH_SIZE: '50',
      OUTBOX_LEASE_MS: '1000',
      OUTBOX_MAX_ATTEMPTS: '3',
      PENDING_WORKER_POLL_MS: '200',
      PENDING_LEASE_MS: '2000',
      RECONCILE_SWEEP_MS: '600000',
      RETENTION_INTERVAL_MS: '600000',
      SHUTDOWN_GRACE_MS: '5000',
      FAULT_INJECTION_ENABLED: String(fault.enabled),
      FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK: String(fault.crashAfterCommitBeforeAck),
      FAULT_CRASH_AFTER_PUBLISH_BEFORE_MARK: String(fault.crashAfterPublishBeforeMark),
      FAULT_CRASH_AFTER_CLAIM_OUTBOX: String(fault.crashAfterClaimOutbox),
      ...this.options.env,
      ...(this.options.envByIndex?.[node.index] ?? {}),
    };

    const child = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      cwd: PROJECT_ROOT,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.processes.set(node.index, child);
    const sink: string[] = [];
    this.logs.set(node.index, sink);
    void this.drain(child.stdout as ReadableStream<Uint8Array>, sink);
    void this.drain(child.stderr as ReadableStream<Uint8Array>, sink);
  }

  private async drain(
    stream: ReadableStream<Uint8Array>,
    sink: string[],
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (!value) continue;
        sink.push(decoder.decode(value));
        if (sink.length > 400) sink.splice(0, sink.length - 200);
      }
    } catch {
      // processo morto: stream encerrado
    }
  }

  private async waitReady(node: ClusterInstance): Promise<void> {
    try {
      await eventually(
        async () => {
          const response = await fetch(`${node.url}/health/ready`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (response.status !== 200) {
            throw new Error(`readiness ${response.status}`);
          }
        },
        {
          timeoutMs: this.options.readyTimeoutMs ?? 60_000,
          intervalMs: 150,
          message: `instância ${node.instanceId} pronta`,
        },
      );
    } catch (error) {
      throw new Error(
        `instância ${node.instanceId} não subiu: ${(error as Error).message}\n${this.tail()}`,
      );
    }
  }
}

export async function stopCluster(cluster: AppCluster | null): Promise<void> {
  await cluster?.stop();
}
