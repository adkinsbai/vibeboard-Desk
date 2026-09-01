export function salarySnapshot(now = new Date(), options = {}) {
  const startHour = Number.isFinite(options.startHour) ? options.startHour : 9;
  const endHour = Number.isFinite(options.endHour) ? options.endHour : 18;
  const dailySalary = Number.isFinite(options.dailySalary) ? options.dailySalary : 1000;
  const start = new Date(now);
  start.setHours(startHour, 0, 0, 0);
  const end = new Date(now);
  end.setHours(endHour, 0, 0, 0);
  const shiftMs = Math.max(1, end - start);
  const elapsedMs = Math.min(Math.max(now - start, 0), shiftMs);
  const amount = (elapsedMs / shiftMs) * dailySalary;
  const phase = now < start ? "waiting" : now >= end ? "complete" : "earning";
  return {
    amount,
    integerAmount: Math.floor(amount),
    progress: elapsedMs / shiftMs,
    phase,
    total: dailySalary,
    start,
    end,
  };
}
