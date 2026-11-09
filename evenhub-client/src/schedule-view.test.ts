import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduledTime, upcomingJobs } from "./schedule-view";

test("upcoming jobs follow the Hermes calendar across a DST boundary", () => {
  const job = (name: string, nextRunAt: string, paused = false) => ({
    id: name,
    name,
    nextRunAt,
    paused,
    schedule: "",
    state: "scheduled",
  });
  const jobs = [
    job("late", "2026-03-30T02:00:00Z"),
    job("paused", "2026-03-29T04:00:00Z", true),
    job("tomorrow", "2026-03-29T22:10:00Z"),
    job("today", "2026-03-29T20:00:00Z"),
    job("today-first", "2026-03-29T08:00:00Z"),
  ];
  const groups = upcomingJobs(
    jobs,
    Date.parse("2026-03-28T23:30:00Z"),
    "Europe/Berlin",
  );
  assert.deepEqual(
    groups.map(({ title, jobs }) => [title, jobs.map((item) => item.name)]),
    [
      ["Сегодня", ["today-first", "today"]],
      ["Завтра", ["tomorrow", "late"]],
      ["Без ближайшего запуска", ["paused"]],
    ],
  );
  assert.match(scheduledTime(jobs[0].nextRunAt, "Europe/Berlin"), /04:00/);
});
