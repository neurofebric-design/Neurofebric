export type PlatformEvent =
  | "TASK_CREATED" | "TASK_STARTED" | "PLAN_CREATED" | "PLAN_VALIDATED" | "SKILL_DISCOVERED"
  | "SKILL_SELECTED" | "TOOL_SELECTED" | "TOOL_STARTED" | "TOOL_COMPLETED" | "TOOL_FAILED"
  | "VALIDATION_STARTED" | "VALIDATION_COMPLETED" | "VALIDATION_FAILED" | "RECOVERY_STARTED"
  | "RETRY_STARTED" | "REPLAN_STARTED" | "REPLAN_COMPLETED" | "APPROVAL_REQUIRED"
  | "APPROVAL_GRANTED" | "APPROVAL_DENIED" | "TASK_COMPLETED" | "TASK_FAILED" | "TASK_CANCELLED";

export interface PlatformEventRecord {
  eventId: string;
  type: PlatformEvent;
  taskId: string;
  correlationId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export type EventSink = (event: PlatformEventRecord) => void | Promise<void>;

export class EventBus {
  private readonly sinks = new Set<EventSink>();
  private readonly history: PlatformEventRecord[] = [];

  subscribe(sink: EventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  async emit(event: PlatformEventRecord): Promise<void> {
    this.history.push(event);
    if (this.history.length > 500) this.history.shift();
    await Promise.all([...this.sinks].map((sink) => sink(event)));
  }

  recent(limit = 100): PlatformEventRecord[] {
    return this.history.slice(-limit);
  }
}
