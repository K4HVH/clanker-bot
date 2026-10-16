// The local command writes only to test servers: the production server changes through /server,
// where the owner reads the plan and presses Apply. Without the production id it can't tell which
// server that is, so it applies nowhere.
export function assertNotProduction(guildId: string, env: Record<string, string | undefined>): void {
  if (!env.DISCORD_GUILD_ID) {
    throw new Error("DISCORD_GUILD_ID is not set: run from the checkout, where .env names the production server.");
  }
  if (guildId === env.DISCORD_GUILD_ID) {
    throw new Error("Refusing to apply to the production server: use /server there.");
  }
}
