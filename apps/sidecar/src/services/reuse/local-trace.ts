import { BasicTracerProvider, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { SessionEvent } from "@socrates/core";

/** Local by default. Nothing reads OTEL environment variables or installs a network exporter. */
export class LocalServiceTracer {
  private readonly provider: BasicTracerProvider;
  constructor(options: { exporter?: SpanExporter } = {}) {
    this.provider = new BasicTracerProvider({ spanProcessors: options.exporter ? [new SimpleSpanProcessor(options.exporter)] : [] });
  }

  recordEvent(event: SessionEvent): { traceId: string; spanId: string } {
    // Deliberate allowlist: never pass payloads, prompts, credentials, filenames or reasoning through tracing.
    const span = this.provider.getTracer("socrates.services", "cost-aware-v1").startSpan(event.type, {
      attributes: {
        "socrates.event_id": event.eventId,
        "socrates.room_id": event.sessionId,
        "socrates.sequence": event.seq,
        ...(event.taskId ? { "socrates.root_task_id": event.taskId } : {}),
      },
    });
    const { traceId, spanId } = span.spanContext();
    span.end();
    return { traceId, spanId };
  }

  flush(): Promise<void> { return this.provider.forceFlush(); }
  shutdown(): Promise<void> { return this.provider.shutdown(); }
}

export const localServiceTracer = new LocalServiceTracer();
export const recordServiceEvent = (event: SessionEvent) => localServiceTracer.recordEvent(event);
