import { describe, expect, test } from "bun:test";
import { createActivityThrottle } from "../activity-throttle";

describe("createActivityThrottle", () => {
  test("coalesces rapid activity emits", async () => {
    const emitted: string[] = [];
    const throttle = createActivityThrottle((activity) => {
      emitted.push(activity.id);
    }, 50);

    throttle.emit({
      id: "a1",
      at: new Date().toISOString(),
      phase: "work",
      kind: "status",
      status: "running",
      title: "first",
    });
    throttle.emit({
      id: "a2",
      at: new Date().toISOString(),
      phase: "work",
      kind: "status",
      status: "running",
      title: "second",
    });

    expect(emitted).toEqual(["a1"]);
    await Bun.sleep(60);
    expect(emitted).toEqual(["a1", "a2"]);
    throttle.flush();
  });
});
