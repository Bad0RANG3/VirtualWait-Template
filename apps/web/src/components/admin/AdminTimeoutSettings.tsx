"use client";

export function AdminTimeoutSettings({
  playingMin,
  headMin,
  busy,
  onPlayingMin,
  onHeadMin,
  onSave,
}: {
  playingMin: number;
  headMin: number;
  busy: boolean;
  onPlayingMin: (v: number) => void;
  onHeadMin: (v: number) => void;
  onSave: () => void;
}) {
  return (
    <section className="panel p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink-900">超时</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="playing-min">游玩</label>
          <input id="playing-min" className="field" type="number" min={1} max={1440}
            value={playingMin} onChange={(e) => onPlayingMin(Number(e.target.value))} />
        </div>
        <div>
          <label className="label" htmlFor="head-min">队头确认</label>
          <input id="head-min" className="field" type="number" min={1} max={60}
            value={headMin} onChange={(e) => onHeadMin(Number(e.target.value))} />
        </div>
      </div>
      <button className="btn-mint mt-3" disabled={busy} onClick={onSave}>
        {busy ? "保存中…" : "保存"}
      </button>
    </section>
  );
}
