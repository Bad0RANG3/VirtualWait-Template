import type { PublicQueueSnapshot } from "@/lib/types";
import { Users } from "lucide-react";

export function QueueStatusHeader({
  data, machineName, hoursLabel,
}: {
  data: PublicQueueSnapshot;
  machineName: string;
  hoursLabel: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-xs text-ink-500">
        {data.venue.name}
        {data.venue.regionName
          ? ` · ${data.venue.regionName}${
              data.venue.regionKind === "county" ? "县"
              : data.venue.regionKind === "district" ? "区" : ""}`
          : ""}
        {data.venue.address ? ` · ${data.venue.address}` : ""}
      </div>
      <h1 className="mt-0.5 font-display text-2xl font-semibold tracking-tight text-ink-950 sm:text-3xl">
        {machineName}
      </h1>
      <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
        <span className="chip bg-ink-50 text-ink-700">
          <Users className="mr-1 h-3.5 w-3.5" />{data.slots.length} 组
        </span>
        <span className="chip bg-ink-50 text-ink-700">机台 {data.venue.machineCount ?? "—"}</span>
        <span className="chip bg-ink-50 text-ink-700">{data.queue.coinCost ?? 1} 币</span>
        <span className="chip bg-ink-50 text-ink-700">游玩 {Math.round(data.queue.playingTimeoutSec / 60)} 分</span>
        <span className="chip bg-ink-50 text-ink-700">确认 {Math.round(data.queue.headConfirmTimeoutSec / 60)} 分</span>
        <span className="chip bg-ink-50 text-ink-700">{hoursLabel}</span>
      </div>
    </div>
  );
}
