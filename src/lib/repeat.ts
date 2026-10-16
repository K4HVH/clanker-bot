// Runs `read` now and again `everyMs` after each run ends, so a slow run (a long first post) is never
// overlapped by the next, and one that throws doesn't stop the rest.
export function repeat(read: () => Promise<void>, everyMs: number, failed: (error: unknown) => void = () => {}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const loop = async () => {
    await read().catch(failed);
    if (stopped) return;
    timer = setTimeout(() => void loop(), everyMs);
    timer.unref?.();
  };
  void loop();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
