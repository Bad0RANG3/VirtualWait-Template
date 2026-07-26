"use client";

import type { AdminAuditEvent } from "@/lib/types";

export function AdminAuditLog({ events }: { events: AdminAuditEvent[] }) {
  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-ink-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-900">最近审计事件</h2>
      </div>
      <div className="divide-y divide-ink-100">
        {events.length === 0 && (
          <p className="px-4 py-5 text-sm text-ink-500">暂无事件。</p>
        )}
        {events.map((e) => (
          <div key={e.id} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2 text-ink-700">
              <span className="font-medium">{e.action}</span>
              <time className="text-ink-400">
                {new Date(e.createdAt).toLocaleString("zh-CN")}
              </time>
            </div>
            <div className="mt-1 break-all text-xs text-ink-500">
              {e.resourceType} · {e.resourceId} · {JSON.stringify(e.metadata)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
