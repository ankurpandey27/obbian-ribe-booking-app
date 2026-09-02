import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../observability/metrics.service';

export type RedisFailurePolicy = 'open' | 'closed';
export type RedisBreakerState = 'closed' | 'open' | 'half_open';

interface Circuit {
  failures: number;
  state: RedisBreakerState;
  openedAt: number;
  trialInFlight: boolean;
}

@Injectable()
export class RedisCircuitBreaker {
  private readonly logger = new Logger(RedisCircuitBreaker.name);
  private readonly enabled: boolean;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly timeoutMs: number;
  private readonly circuits = new Map<string, Circuit>();

  constructor(
    config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled = config.get<boolean>('resilience.breakerEnabled', true);
    this.failureThreshold = Math.max(
      1,
      config.get<number>('resilience.breakerFailureThreshold', 5),
    );
    this.openMs = Math.max(
      1,
      config.get<number>('resilience.breakerOpenMs', 10000),
    );
    this.timeoutMs = Math.max(
      1,
      config.get<number>('resilience.commandTimeoutMs', 1000),
    );
  }

  async execute<T>(
    name: string,
    policy: RedisFailurePolicy,
    command: () => Promise<T>,
  ): Promise<T | undefined> {
    const circuit = this.getCircuit(name);
    if (this.enabled && !this.allow(circuit)) {
      if (policy === 'open') return undefined;
      throw new Error(`Redis circuit open for ${name}`);
    }

    try {
      const result = await this.withTimeout(command());
      this.succeed(name, circuit);
      return result;
    } catch (err) {
      this.fail(name, circuit, err);
      if (policy === 'open') return undefined;
      throw err;
    }
  }

  state(name: string): RedisBreakerState {
    return this.getCircuit(name).state;
  }

  private getCircuit(name: string): Circuit {
    let circuit = this.circuits.get(name);
    if (!circuit) {
      circuit = {
        failures: 0,
        state: 'closed',
        openedAt: 0,
        trialInFlight: false,
      };
      this.circuits.set(name, circuit);
      this.metrics?.setRedisBreakerState(name, circuit.state);
    }
    return circuit;
  }

  private allow(circuit: Circuit): boolean {
    if (circuit.state === 'closed') return true;
    if (circuit.state === 'open') {
      if (Date.now() - circuit.openedAt < this.openMs) return false;
      circuit.state = 'half_open';
      circuit.trialInFlight = true;
      this.metrics?.setRedisBreakerState(this.nameFor(circuit), circuit.state);
      return true;
    }
    return !circuit.trialInFlight && (circuit.trialInFlight = true);
  }

  private succeed(name: string, circuit: Circuit): void {
    circuit.failures = 0;
    circuit.trialInFlight = false;
    if (circuit.state !== 'closed') {
      circuit.state = 'closed';
      this.metrics?.setRedisBreakerState(name, circuit.state);
    }
  }

  private fail(name: string, circuit: Circuit, err: unknown): void {
    circuit.trialInFlight = false;
    circuit.failures += 1;
    if (
      circuit.state === 'half_open' ||
      circuit.failures >= this.failureThreshold
    ) {
      circuit.state = 'open';
      circuit.openedAt = Date.now();
      this.metrics?.setRedisBreakerState(name, circuit.state);
      this.logger.warn(
        `Redis circuit ${name} opened after ${circuit.failures} failures`,
      );
    }
    if (circuit.state === 'closed') {
      this.metrics?.setRedisBreakerState(name, circuit.state);
    }
    void err;
  }

  private nameFor(circuit: Circuit): string {
    for (const [name, value] of this.circuits) {
      if (value === circuit) return name;
    }
    return 'unknown';
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`Redis command timed out after ${this.timeoutMs}ms`),
              ),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
