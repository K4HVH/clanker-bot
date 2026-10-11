// The local command writes only to test servers: the production server changes through /server,
// where the owner reads the plan and presses Apply.
export function assertNotProduction(guildId: string, env: Record<string, string | undefined>): void {
  if (guildId === env.DISCORD_GUILD_ID) {
    throw new Error("Refusing to apply to the production server: use /server there.");
  }
}
