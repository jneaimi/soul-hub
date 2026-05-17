import { apiGet } from '../api.ts';
import { emit, type OutputOpts } from '../output.ts';

interface SchedTask {
  id?: string;
  name?: string;
  cron?: string;
  enabled?: boolean;
  lastRun?: string | number | null;
  nextRun?: string | number | null;
  lastStatus?: string | null;
}
interface TasksResp { tasks: SchedTask[]; }

export async function tasks(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<TasksResp>('/api/scheduler/tasks');
  emit(data, opts, (d: TasksResp) =>
    d.tasks.length === 0
      ? '(no scheduler tasks)'
      : d.tasks
          .map((t) => {
            const en = t.enabled === false ? 'off' : 'on ';
            const name = (t.name ?? t.id ?? '').padEnd(34);
            const cron = (t.cron ?? '').padEnd(18);
            const next = String(t.nextRun ?? '—');
            return `${en}  ${name} ${cron} next=${next} last=${t.lastStatus ?? '—'}`;
          })
          .join('\n')
  );
}
