export type AppMainView = "chat" | "task";

export interface AppUrlState {
  workspaceId?: string;
  taskId?: string;
  view: AppMainView;
}

export function readAppUrlState(): AppUrlState {
  const params = new URLSearchParams(window.location.search);
  const workspaceId = params.get("workspace") ?? undefined;
  const taskId = params.get("task") ?? undefined;
  const viewParam = params.get("view");
  const view: AppMainView =
    viewParam === "task" || (taskId && viewParam !== "chat") ? "task" : "chat";
  return { workspaceId, taskId, view: taskId ? view : "chat" };
}

export function writeAppUrlState(state: AppUrlState): void {
  const params = new URLSearchParams();
  if (state.workspaceId) params.set("workspace", state.workspaceId);
  if (state.taskId) {
    params.set("task", state.taskId);
    if (state.view === "task") params.set("view", "task");
  }
  const query = params.toString();
  const nextUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
}
