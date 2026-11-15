import { randomBytes } from 'node:crypto';
import type { Id } from '../core/types.js';
import type { RuntimeHook } from '../runtime/hooks.js';

export type OtelAttributeValue = string | number | boolean;

export type OtelSpanKind = 'INTERNAL' | 'CLIENT' | 'SERVER';

export type OtelSpanStatusCode = 'UNSET' | 'OK' | 'ERROR';

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: OtelSpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, OtelAttributeValue>;
  status: {
    code: OtelSpanStatusCode;
    message?: string;
  };
}

export interface SpanExporter {
  export(spans: OtelSpan[]): Promise<void>;
  shutdown?(): Promise<void>;
}

export class InMemorySpanExporter implements SpanExporter {
  readonly spans: OtelSpan[] = [];

  async export(spans: OtelSpan[]): Promise<void> {
    this.spans.push(...spans);
  }

  clear(): void {
    this.spans.length = 0;
  }
}

export interface OtlpHttpJsonExporterOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  serviceVersion?: string;
  timeoutMs?: number;
}

function toOtlpAnyValue(value: OtelAttributeValue): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}

function toOtlpKind(kind: OtelSpanKind): number {
  if (kind === 'SERVER') return 2;
  if (kind === 'CLIENT') return 3;
  return 1;
}

function toOtlpStatusCode(code: OtelSpanStatusCode): number {
  if (code === 'OK') return 1;
  if (code === 'ERROR') return 2;
  return 0;
}

export function buildOtlpTracePayload(
  spans: OtelSpan[],
  resource: { serviceName: string; serviceVersion?: string }
): Record<string, unknown> {
  const resourceAttrs: Array<Record<string, unknown>> = [
    { key: 'service.name', value: { stringValue: resource.serviceName } },
  ];
  if (resource.serviceVersion) {
    resourceAttrs.push({ key: 'service.version', value: { stringValue: resource.serviceVersion } });
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: {
              name: 'pi-agent-runtime',
              version: '0.1.0',
            },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: toOtlpKind(span.kind),
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano,
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: toOtlpAnyValue(value),
              })),
              status: {
                code: toOtlpStatusCode(span.status.code),
                ...(span.status.message ? { message: span.status.message } : {}),
              },
            })),
          },
        ],
      },
    ],
  };
}

export class OtlpHttpJsonExporter implements SpanExporter {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly serviceName: string;
  private readonly serviceVersion?: string;
  private readonly timeoutMs: number;

  constructor(options: OtlpHttpJsonExporterOptions = {}) {
    this.endpoint = options.endpoint ?? 'http://localhost:4318/v1/traces';
    this.headers = options.headers ?? {};
    this.serviceName = options.serviceName ?? 'pi-agent-runtime';
    this.serviceVersion = options.serviceVersion;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async export(spans: OtelSpan[]): Promise<void> {
    if (spans.length === 0) return;
    const body = JSON.stringify(
      buildOtlpTracePayload(spans, {
        serviceName: this.serviceName,
        serviceVersion: this.serviceVersion,
      })
    );

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.headers,
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OTLP export failed (${response.status}): ${text}`);
    }
  }
}

export class ConsoleSpanExporter implements SpanExporter {
  constructor(private readonly writeLine: (line: string) => void = (line) => console.log(line)) {}

  async export(spans: OtelSpan[]): Promise<void> {
    for (const span of spans) {
      this.writeLine(JSON.stringify(span));
    }
  }
}

function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

function nowUnixNano(): string {
  const ms = BigInt(Date.now());
  return (ms * 1_000_000n).toString();
}

interface ActiveRunTrace {
  traceId: string;
  rootSpanId: string;
  startTimeUnixNano: string;
  sessionId: Id;
  model: string;
  parentSessionId?: Id;
  completedSpans: OtelSpan[];
  pendingModelSpan?: {
    spanId: string;
    stepIndex: number;
    startTimeUnixNano: string;
    model: string;
  };
  pendingToolSpans: Map<
    string,
    {
      spanId: string;
      stepIndex: number;
      toolName: string;
      startTimeUnixNano: string;
    }
  >;
}

export interface OtelTraceHookOptions {
  exporter: SpanExporter;
  onExportError?: (err: unknown) => void;
}

export class OtelTraceHook implements RuntimeHook {
  readonly name = 'otel-trace';
  private readonly traces = new Map<Id, ActiveRunTrace>();

  constructor(private readonly options: OtelTraceHookOptions) {}

  private ensureRunTrace(session: { id: Id; parentSessionId?: Id; config: { model: string } }, runId: Id): ActiveRunTrace {
    let trace = this.traces.get(runId);
    if (!trace) {
      trace = {
        traceId: newTraceId(),
        rootSpanId: newSpanId(),
        startTimeUnixNano: nowUnixNano(),
        sessionId: session.id,
        model: session.config.model,
        parentSessionId: session.parentSessionId,
        completedSpans: [],
        pendingToolSpans: new Map(),
      };
      this.traces.set(runId, trace);
    }
    return trace;
  }

  beforeModelCall(ctx: {
    session: { id: Id; parentSessionId?: Id; config: { model: string } };
    run: { id: Id };
    stepIndex: number;
    request: { model: string };
  }): void {
    const trace = this.ensureRunTrace(ctx.session, ctx.run.id);
    trace.pendingModelSpan = {
      spanId: newSpanId(),
      stepIndex: ctx.stepIndex,
      startTimeUnixNano: nowUnixNano(),
      model: ctx.request.model,
    };
  }

  afterModelCall(ctx: {
    session: { id: Id; parentSessionId?: Id; config: { model: string } };
    run: { id: Id };
    stepIndex: number;
    request: { model: string };
    response: {
      model: string;
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number };
    };
  }): void {
    const trace = this.ensureRunTrace(ctx.session, ctx.run.id);
    const pending = trace.pendingModelSpan;
    if (!pending) return;
    trace.pendingModelSpan = undefined;

    trace.completedSpans.push({
      traceId: trace.traceId,
      spanId: pending.spanId,
      parentSpanId: trace.rootSpanId,
      name: 'gen_ai.chat',
      kind: 'CLIENT',
      startTimeUnixNano: pending.startTimeUnixNano,
      endTimeUnixNano: nowUnixNano(),
      attributes: {
        'session.id': ctx.session.id,
        'run.id': ctx.run.id,
        'step.index': ctx.stepIndex,
        'gen_ai.request.model': pending.model,
        'gen_ai.response.model': ctx.response.model,
        'gen_ai.response.finish_reason': ctx.response.finishReason,
        'gen_ai.usage.input_tokens': ctx.response.usage.inputTokens,
        'gen_ai.usage.output_tokens': ctx.response.usage.outputTokens,
      },
      status: { code: 'OK' },
    });
  }

  beforeToolCall(ctx: {
    session: { id: Id; parentSessionId?: Id; config: { model: string } };
    run: { id: Id };
    stepIndex: number;
    call: { toolCallId: string; toolName: string };
  }): void {
    const trace = this.ensureRunTrace(ctx.session, ctx.run.id);
    trace.pendingToolSpans.set(ctx.call.toolCallId, {
      spanId: newSpanId(),
      stepIndex: ctx.stepIndex,
      toolName: ctx.call.toolName,
      startTimeUnixNano: nowUnixNano(),
    });
  }

  afterToolCall(ctx: {
    session: { id: Id; parentSessionId?: Id; config: { model: string } };
    run: { id: Id };
    stepIndex: number;
    call: { toolCallId: string; toolName: string };
    result: { status: string; durationMs: number; error?: { code: string; message: string } };
  }): void {
    const trace = this.ensureRunTrace(ctx.session, ctx.run.id);
    const pending = trace.pendingToolSpans.get(ctx.call.toolCallId);
    if (!pending) return;
    trace.pendingToolSpans.delete(ctx.call.toolCallId);

    const isError = ctx.result.status === 'error';
    trace.completedSpans.push({
      traceId: trace.traceId,
      spanId: pending.spanId,
      parentSpanId: trace.rootSpanId,
      name: `agent.tool.${ctx.call.toolName}`,
      kind: 'INTERNAL',
      startTimeUnixNano: pending.startTimeUnixNano,
      endTimeUnixNano: nowUnixNano(),
      attributes: {
        'session.id': ctx.session.id,
        'run.id': ctx.run.id,
        'step.index': ctx.stepIndex,
        'tool.name': ctx.call.toolName,
        'tool.call_id': ctx.call.toolCallId,
        'tool.status': ctx.result.status,
        'tool.duration_ms': ctx.result.durationMs,
        ...(ctx.result.error?.code ? { 'error.code': ctx.result.error.code } : {}),
      },
      status: isError
        ? { code: 'ERROR', message: ctx.result.error?.message ?? 'Tool execution error' }
        : { code: 'OK' },
    });
  }

  async onRunFinished(ctx: {
    sessionId: Id;
    outcome: {
      runId: Id;
      status: string;
      stopReason: string | null;
      usage: { inputTokens: number; outputTokens: number };
      error?: { code: string; message: string };
    };
  }): Promise<void> {
    const trace = this.traces.get(ctx.outcome.runId);
    const endTime = nowUnixNano();
    const traceId = trace?.traceId ?? newTraceId();
    const rootSpanId = trace?.rootSpanId ?? newSpanId();

    const spans: OtelSpan[] = [...(trace?.completedSpans ?? [])];
    if (trace?.pendingModelSpan) {
      spans.push({
        traceId,
        spanId: trace.pendingModelSpan.spanId,
        parentSpanId: rootSpanId,
        name: 'gen_ai.chat',
        kind: 'CLIENT',
        startTimeUnixNano: trace.pendingModelSpan.startTimeUnixNano,
        endTimeUnixNano: endTime,
        attributes: {
          'session.id': ctx.sessionId,
          'run.id': ctx.outcome.runId,
          'step.index': trace.pendingModelSpan.stepIndex,
          'gen_ai.request.model': trace.pendingModelSpan.model,
        },
        status: {
          code: 'ERROR',
          message: ctx.outcome.error?.message ?? 'Model call did not complete',
        },
      });
    }

    const isError = ctx.outcome.status === 'failed' || ctx.outcome.status === 'interrupted';
    spans.push({
      traceId,
      spanId: rootSpanId,
      name: 'agent.run',
      kind: 'SERVER',
      startTimeUnixNano: trace?.startTimeUnixNano ?? endTime,
      endTimeUnixNano: endTime,
      attributes: {
        'session.id': ctx.sessionId,
        'run.id': ctx.outcome.runId,
        ...(trace?.parentSessionId ? { 'session.parent_id': trace.parentSessionId } : {}),
        ...(trace?.model ? { 'gen_ai.request.model': trace.model } : {}),
        'agent.run.status': ctx.outcome.status,
        ...(ctx.outcome.stopReason ? { 'agent.stop_reason': ctx.outcome.stopReason } : {}),
        'gen_ai.usage.input_tokens': ctx.outcome.usage.inputTokens,
        'gen_ai.usage.output_tokens': ctx.outcome.usage.outputTokens,
      },
      status: isError
        ? { code: 'ERROR', message: ctx.outcome.error?.message ?? ctx.outcome.status }
        : { code: 'OK' },
    });

    this.traces.delete(ctx.outcome.runId);

    try {
      await this.options.exporter.export(spans);
    } catch (err) {
      this.options.onExportError?.(err);
    }
  }
}
