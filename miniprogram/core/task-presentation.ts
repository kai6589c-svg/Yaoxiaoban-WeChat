import type { TodayTask } from "./models";
export const taskStatusText = (task: TodayTask): string =>
  ({
    upcoming: `今天 ${task.time}`,
    due: "到时尚未记录 · 已按计划估算余量",
    taken: "已记录服用",
    skipped: "已记未服",
    "needs-review": "管理期限已过，请先核对药盒",
  })[task.status];
export const groupTodayTasks = <T extends TodayTask & { statusClass: string }>(
  tasks: T[],
): Array<T & { groupLabel: string; showGroupHeading: boolean }> => {
  const label = (task: T) =>
    task.statusClass === "pending-sync"
      ? "待同步"
      : task.status === "needs-review"
        ? "需要核对"
        : task.status === "due"
          ? "待处理"
          : task.status === "upcoming"
            ? "接下来"
            : "已记录";
  const order = ["需要核对", "待处理", "待同步", "接下来", "已记录"];
  const sorted = [...tasks].sort(
    (a, b) =>
      order.indexOf(label(a)) - order.indexOf(label(b)) ||
      a.scheduledAtMs - b.scheduledAtMs ||
      a.key.localeCompare(b.key),
  );
  return sorted.map((task, i) => ({
    ...task,
    groupLabel: label(task),
    showGroupHeading: i === 0 || label(sorted[i - 1]!) !== label(task),
  }));
};
