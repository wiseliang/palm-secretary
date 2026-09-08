import { ProjectStore, type ProjectTask } from './project-store.js';
import { reconcileTurn } from './task-reconciliation.js';

type Report = { checked: number; recovered: number; unresolved: number; unavailable: number };
const empty = (): Report => ({ checked: 0, recovered: 0, unresolved: 0, unavailable: 0 });

export class TaskReconciler {
  private stopped = false;
  stop(): void { this.stopped = true; }
  private inFlight = new Map<string, Promise<Report>>();
  private lastCheck = new Map<string, number>();
  constructor(
    private readonly projects: ProjectStore,
    private readonly readHistory: (threadId: string) => Promise<unknown>,
    private readonly blocked: (projectId: string) => boolean,
    private readonly changed: (task: ProjectTask) => void,
    private readonly intervalMs = 15_000,
  ) {}

  async run(projectId?: string, force = false): Promise<Report> {
    const ids = projectId ? [projectId] : [...new Set(this.projects.reconciliationCandidates().map((task) => task.projectId))];
    const total = empty();
    for (const id of ids) {
      const report = await this.project(id, force);
      for (const key of Object.keys(total) as Array<keyof Report>) total[key] += report[key];
    }
    return total;
  }

  private async project(id: string, force: boolean): Promise<Report> {
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const now = Date.now();
    if (this.stopped || this.blocked(id) || (!force && now - (this.lastCheck.get(id) ?? 0) < this.intervalMs)) return empty();
    for (const [key, checked] of this.lastCheck) if (now - checked > 300_000) this.lastCheck.delete(key);
    const tasks = this.projects.reconciliationCandidates(id).filter((task) => force || task.submissionPending || now - Date.parse(task.startedAt) >= this.intervalMs);
    if (!tasks.length) return empty();
    this.lastCheck.set(id, now);
    const operation = (async () => {
      const report = empty();
      for (const task of tasks) {
        if (this.stopped || this.blocked(id)) break;
        report.checked += 1;
        try {
          const history = await this.readHistory(task.threadId);
          if (this.stopped || this.blocked(id)) { report.unresolved += 1; continue; }
          const turn = reconcileTurn(task, history);
          if (!turn) { report.unresolved += 1; continue; }
          const updated = await this.projects.applyReconciliation(id, task.taskId, turn);
          if (updated) { report.recovered += 1; this.changed(updated); }
        } catch { report.unavailable += 1; }
      }
      return report;
    })();
    this.inFlight.set(id, operation);
    try { return await operation; } finally { this.inFlight.delete(id); }
  }
}
