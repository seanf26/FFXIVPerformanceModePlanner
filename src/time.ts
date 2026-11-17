export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = (total % 60).toString().padStart(2, "0");
  return hours ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}
