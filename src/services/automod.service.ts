export const INVITE_REGEX = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i;
export const LINK_REGEX = /https?:\/\/[^\s]+/i;

export interface AutomodConfig {
  spam: boolean;
  invites: boolean;
  links: boolean;
  mentionLimit: number;
}

// Content-based checks (mention-spam + invite/link). Heat-based spam is handled
// statefully in the listener via HeatTracker.
export function checkContentRules(
  content: string,
  mentionCount: number,
  cfg: AutomodConfig,
): string | null {
  if (cfg.spam && mentionCount > cfg.mentionLimit) return "mention spam";
  if (cfg.invites && INVITE_REGEX.test(content)) return "invite link";
  if (cfg.links && LINK_REGEX.test(content)) return "external link";
  return null;
}
