import { expect, test } from "bun:test";
import { workspaceName } from "./index";

test("exposes workspace name", () => {
  expect(workspaceName).toBe("@sikong/tooling");
});
