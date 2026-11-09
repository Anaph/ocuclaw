import type { Job } from "./workspace";

export function upcomingJobs(jobs: Job[], now: number, timezone: string) {
  if (!Number.isFinite(now)) return [{ title: "", jobs }];
  let day: Intl.DateTimeFormat;
  try {
    day = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return [{ title: "", jobs }];
  }
  const calendarDate = (time: number) => {
    const parts = day.formatToParts(time);
    return ["year", "month", "day"]
      .map((part) => parts.find((value) => value.type === part)?.value)
      .join("-");
  };
  const today = calendarDate(now);
  // Advance the local calendar date, including days with a DST transition.
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  const groups = ["Сегодня", "Завтра", "Позже", "Без ближайшего запуска"].map(
    (title) => ({ title, jobs: [] as Job[] }),
  );
  const sorted = jobs
    .map((job) => ({
      job,
      time: job.paused ? NaN : Date.parse(job.nextRunAt || ""),
    }))
    .sort(
      (a, b) =>
        (Number.isFinite(a.time) ? a.time : Infinity) -
        (Number.isFinite(b.time) ? b.time : Infinity),
    );
  for (const { job, time } of sorted) {
    const date = Number.isFinite(time) ? calendarDate(time) : "";
    groups[date === today ? 0 : date === tomorrow ? 1 : date ? 2 : 3].jobs.push(
      job,
    );
  }
  return groups.filter((group) => group.jobs.length);
}

export function scheduledTime(
  value: string | undefined,
  timezone: string | undefined,
) {
  if (!value) return "—";
  const time = Date.parse(value);
  if (!timezone || !Number.isFinite(time)) return value.replace("T", " ");
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      dateStyle: "short",
      timeStyle: "short",
    }).format(time);
  } catch {
    return value.replace("T", " ");
  }
}
