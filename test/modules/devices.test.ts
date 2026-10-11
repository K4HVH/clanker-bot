import { expect, test } from "bun:test";
import { repeat } from "../../src/modules/devices/index";

test("a read slower than the interval is never overlapped by the next", async () => {
  let running = 0;
  let most = 0;
  let reads = 0;
  const stop = repeat(async () => {
    running++;
    reads++;
    most = Math.max(most, running);
    await Bun.sleep(30);
    running--;
  }, 5);
  await Bun.sleep(120);
  stop();
  expect(most).toBe(1);
  expect(reads).toBeGreaterThanOrEqual(2);
});
