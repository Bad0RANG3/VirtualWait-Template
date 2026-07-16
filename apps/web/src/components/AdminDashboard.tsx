"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Queue = { id: string; name: string; slug: string; status: "OPEN" | "PAUSED" | "CLOSED" };
type AuditEvent = { id: string; action: string; resourceType: string; resourceId: string; metadata: unknown; createdAt: string };
type Entry = { id: string; queueName: string; nickname: string; status: "WAITING" | "PLAYING"; version: number; isDuo: boolean };

export function AdminDashboard({ queues, events, entries }: { queues: Queue[]; events: AuditEvent[]; entries: Entry[] }) {
  const router = useRouter();
  const [busyQueue, setBusyQueue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function updateStatus(queueId: string, status: Queue["status"]) {
    setBusyQueue(queueId);
    setError(null);
    try {
      const response = await fetch(`/api/admin/queues/${encodeURIComponent(queueId)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "队列更新失败");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "队列更新失败");
    } finally {
      setBusyQueue(null);
    }
  }

  async function logout() {
    await fetch("/api/admin/session", { method: "DELETE" });
    router.refresh();
  }

  async function entryAction(entry: Entry, action: "START" | "REQUEUE" | "CANCEL" | "FINISH") {
    setBusyQueue(entry.id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/entries/${encodeURIComponent(entry.id)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: entry.version }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "记录操作失败");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "记录操作失败");
    } finally {
      setBusyQueue(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="section-label">OPERATIONS</div>
          <h1 className="mt-3 font-display text-3xl font-semibold text-ink-900">队列运维台</h1>
          <p className="mt-2 text-sm text-ink-500">队列开关会立即写入审计日志；人工变更排队记录仍需后续审批流程。</p>
        </div>
        <button className="btn-ghost" onClick={logout}>退出管理员会话</button>
      </div>

      {error && <div className="rounded-xl border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">{error}</div>}

      <section className="grid gap-4 md:grid-cols-2">
        {queues.map((queue) => (
          <div key={queue.id} className="panel p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-xl font-semibold text-ink-900">{queue.name}</h2>
              <span className="chip bg-ink-50 text-ink-600">{queue.status}</span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {(["OPEN", "PAUSED", "CLOSED"] as const).map((status) => (
                <button
                  key={status}
                  className={status === "OPEN" ? "btn-mint" : status === "CLOSED" ? "btn-coral" : "btn-ghost"}
                  disabled={busyQueue === queue.id || queue.status === status}
                  onClick={() => updateStatus(queue.id, status)}
                >
                  {status === "OPEN" ? "开放" : status === "PAUSED" ? "暂停" : "关闭"}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-ink-100 px-5 py-4">
          <h2 className="font-display text-xl font-semibold text-ink-900">活动排队记录</h2>
          <p className="mt-1 text-xs text-ink-500">操作需要记录版本一致；拼机会按整组执行，避免只改变一名成员。</p>
        </div>
        <div className="divide-y divide-ink-100">
          {entries.length === 0 && <p className="px-5 py-5 text-sm text-ink-500">暂无活动记录。</p>}
          {entries.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="text-sm">
                <div className="font-medium text-ink-800">{entry.nickname} · {entry.queueName}</div>
                <div className="mt-1 text-xs text-ink-500">{entry.status} · 版本 {entry.version}{entry.isDuo ? " · 拼机（受保护）" : ""}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {entry.status === "WAITING" && <button className="btn-mint" disabled={busyQueue === entry.id} onClick={() => entryAction(entry, "START")}>开始游玩{entry.isDuo ? "整组" : ""}</button>}
                <button className="btn-ghost" disabled={busyQueue === entry.id} onClick={() => entryAction(entry, "REQUEUE")}>调至队尾{entry.isDuo ? "整组" : ""}</button>
                {entry.status !== "PLAYING" && <button className="btn-coral" disabled={busyQueue === entry.id} onClick={() => entryAction(entry, "CANCEL")}>取消{entry.isDuo ? "整组" : ""}</button>}
                {entry.status === "PLAYING" && <button className="btn-primary" disabled={busyQueue === entry.id} onClick={() => entryAction(entry, "FINISH")}>结束{entry.isDuo ? "整组" : ""}</button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-ink-100 px-5 py-4">
          <h2 className="font-display text-xl font-semibold text-ink-900">最近审计事件</h2>
        </div>
        <div className="divide-y divide-ink-100">
          {events.length === 0 && <p className="px-5 py-5 text-sm text-ink-500">暂无事件。</p>}
          {events.map((event) => (
            <div key={event.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2 text-ink-700">
                <span className="font-medium">{event.action}</span>
                <time className="text-ink-400">{new Date(event.createdAt).toLocaleString("zh-CN")}</time>
              </div>
              <div className="mt-1 break-all text-xs text-ink-500">{event.resourceType} · {event.resourceId} · {JSON.stringify(event.metadata)}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
