import { cn } from "@/lib/utils";

// Board 1d's reading progress: a 2px Sand track with an Ink fill. `percent` is clamped to 0-100.
export function ProgressLine({ percent, className }: { percent: number; className?: string }) {
  const value = Math.min(100, Math.max(0, Math.round(percent)));

  return (
    <div
      aria-hidden="true"
      className={cn("h-0.5 w-full bg-sand", className)}
    >
      <div className="h-0.5 bg-ink transition-[width] duration-200 ease-quiet" style={{ width: `${value}%` }} />
    </div>
  );
}
