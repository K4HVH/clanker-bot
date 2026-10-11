import { expect, test } from "bun:test";
import { modules } from "../../src/modules/index";
import { privacyModule } from "../../src/modules/privacy/index";
import { fakeInteraction, silentContext } from "../helpers/fakes";

test("/privacy points at the policy and the deletion route", async () => {
  const i = fakeInteraction("privacy");
  await privacyModule.commands![0]!.execute(i, silentContext());
  expect(i.replies).toEqual([
    {
      content: [
        "How this bot handles your data: <https://medius.k4tech.net/privacy>",
        "Open a ticket to have the bot's data on you deleted, or to report a problem with the bot.",
      ].join("\n"),
      flags: 64,
    },
  ]);
});

test("/privacy is registered and open to everyone", () => {
  expect(modules).toContain(privacyModule);
  const data = privacyModule.commands![0]!.data.toJSON() as { default_member_permissions?: string | null };
  expect(data.default_member_permissions ?? null).toBeNull();
});
