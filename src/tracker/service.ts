import { FakeTrackerWriter } from './fake';
import { LinearTracker } from './linear';
import { TrackerNotConfigured } from './interface';
import type { TrackerTaskInput, TrackerWriteResult, TrackerWriter, TrackerOpenTask } from './interface';

/** Linear is deferred: preserve confirmed work in Seros without fabricating an external issue. */
class DeferredTrackerWriter implements TrackerWriter {
  getName(): string { return 'deferred'; }
  async isReady(): Promise<boolean> { return false; }
  async write(_input: TrackerTaskInput): Promise<TrackerWriteResult> {
    throw new TrackerNotConfigured('Linear tracker configuration is deferred; task remains queued');
  }
  async listOpenTasks(_limit?: number): Promise<TrackerOpenTask[]> { return []; }
}


/**
 * Which tracker this deployment writes to, decided by SEROS_TRACKER:
 *
 *   linear         the v0 tracker (LINEAR_API_KEY, LINEAR_TEAM_ID)
 *   fake           an in-process tracker, for tests and local development
 *   unset          tracker deferred; confirmed tasks remain queued
 *
 * A misspelled value fails loudly rather than falling back to `fake`: silently
 * writing confirmed tasks into a tracker nobody can see is exactly the failure
 * this file exists to prevent.
 */
export class TrackerService {
  private static instance: TrackerService | undefined;
  private writer: TrackerWriter;

  private constructor(writer: TrackerWriter) { this.writer = writer; }

  static getInstance(): TrackerService {
    if (!TrackerService.instance) TrackerService.instance = new TrackerService(buildFromEnv());
    return TrackerService.instance;
  }

  /** Tests and the worker's own setup replace the writer explicitly. */
  static reset(writer?: TrackerWriter): void {
    TrackerService.instance = writer ? new TrackerService(writer) : undefined;
  }

  getWriter(): TrackerWriter { return this.writer; }
  setWriter(writer: TrackerWriter): void { this.writer = writer; }
}

function buildFromEnv(): TrackerWriter {
  const raw = (process.env.SEROS_TRACKER || '').trim().toLowerCase();
  if (!raw) return new DeferredTrackerWriter();
  switch (raw) {
    case 'linear': return new LinearTracker();
    case 'fake':   return new FakeTrackerWriter();
    default:
      throw new TrackerNotConfigured(`SEROS_TRACKER=${JSON.stringify(raw)} is not a tracker this build knows (linear, fake)`);
  }
}
