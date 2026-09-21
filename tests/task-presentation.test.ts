import { expect, it } from "vitest";
import { buildTodayDashboard } from "../miniprogram/core/dashboard";
import {
  groupTodayTasks,
  taskStatusText,
} from "../miniprogram/core/task-presentation";
import { localDateTimeToMs } from "../miniprogram/core/dates";
import { appState } from "./fixtures";
it("unrecorded due tasks remain unrecorded; local pending records have their own group", () => {
  const task = buildTodayDashboard(
    appState(),
    localDateTimeToMs("2026-08-21", "10:00"),
  ).tasks[0]!;
  expect(task.status).toBe("due");
  expect(taskStatusText(task)).toContain("尚未记录");
  const result = groupTodayTasks([
    {
      ...task,
      key: "recorded",
      status: "taken" as const,
      statusClass: "taken",
    },
    { ...task, key: "offline", statusClass: "pending-sync" },
    { ...task, key: "due", statusClass: "due" },
    {
      ...task,
      key: "review",
      status: "needs-review" as const,
      statusClass: "review",
    },
  ]);
  expect(result.map((item) => item.groupLabel)).toEqual([
    "需要核对",
    "待处理",
    "待同步",
    "已记录",
  ]);
  expect(result.find((item) => item.key === "offline")?.status).toBe("due");
});
