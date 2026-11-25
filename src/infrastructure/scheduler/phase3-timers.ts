import { autoCloseStaleRepairTickets } from '../../modules/repair-tickets/repair-ticket.service';

export interface ScheduledJobDefinition {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
}

const registeredJobs = new Map<string, ScheduledJobDefinition>();
const activeTimers: NodeJS.Timeout[] = [];

/**
 * Đăng ký tác vụ định kỳ nhẹ cho Phase 3 (vd: hết hạn giữ chỗ hợp đồng, tự đóng sự cố sau 5 ngày).
 */
export function registerPhase3Job(job: ScheduledJobDefinition): void {
  registeredJobs.set(job.name, job);
}

/**
 * Khởi chạy các tác vụ định kỳ đã đăng ký.
 * Tự động bỏ qua khi NODE_ENV === 'test' để tránh rò rỉ handle khi chạy node:test.
 */
export function startPhase3Timers(env: NodeJS.ProcessEnv = process.env): () => void {
  if (env.NODE_ENV === 'test') {
    return () => {};
  }

  stopPhase3Timers();

  for (const job of registeredJobs.values()) {
    let isRunning = false;
    const timer = setInterval(() => {
      if (isRunning) {
        return;
      }
      isRunning = true;
      job
        .handler()
        .catch((err) => {
          console.error(`[Phase3Timer] Lỗi khi chạy job "${job.name}":`, err);
        })
        .finally(() => {
          isRunning = false;
        });
    }, job.intervalMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    activeTimers.push(timer);
  }

  return stopPhase3Timers;
}

export function stopPhase3Timers(): void {
  while (activeTimers.length > 0) {
    const timer = activeTimers.pop();
    if (timer) {
      clearInterval(timer);
    }
  }
}

export function clearRegisteredPhase3Jobs(): void {
  stopPhase3Timers();
  registeredJobs.clear();
}

export function listRegisteredPhase3Jobs(): readonly ScheduledJobDefinition[] {
  return Array.from(registeredJobs.values());
}

/**
 * Đăng ký tác vụ tự động đóng phiếu sự cố quá 5 ngày chưa nghiệm thu (chu kỳ 15 phút, batch 100).
 */
export function registerRepairTicketAutoCloseJob(): void {
  registerPhase3Job({
    name: 'repair-ticket-auto-close',
    intervalMs: 15 * 60 * 1000,
    handler: async () => {
      await autoCloseStaleRepairTickets({ batchSize: 100 });
    },
  });
}
