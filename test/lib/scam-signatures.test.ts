import { expect, test } from "bun:test";
import { forgetButton } from "../../src/lib/scam-signatures";

test("forgetButton: a match alert's button reads Not a scam", () => {
  const [button] = forgetButton("domain", "claim-nitro.gift").toJSON().components;
  expect(button).toMatchObject({ label: "Not a scam" });
});
