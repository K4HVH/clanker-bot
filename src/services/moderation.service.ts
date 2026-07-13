export interface ActionableInput {
  actorId: string;
  targetId: string;
  botId: string;
  guildOwnerId: string;
  actorHighestRole: number;
  targetHighestRole: number;
  botHighestRole: number;
  targetIsMember: boolean;
}

export type ActionCheck = { ok: true } | { ok: false; reason: string };

export function checkActionable(input: ActionableInput): ActionCheck {
  if (input.targetId === input.actorId) return { ok: false, reason: "You can't action yourself." };
  if (input.targetId === input.botId) return { ok: false, reason: "I can't action myself." };
  if (input.targetId === input.guildOwnerId) {
    return { ok: false, reason: "You can't action the server owner." };
  }
  if (input.targetIsMember) {
    if (input.targetHighestRole >= input.actorHighestRole) {
      return { ok: false, reason: "You can't action someone with an equal or higher role." };
    }
    if (input.targetHighestRole >= input.botHighestRole) {
      return { ok: false, reason: "My role isn't high enough to action that user." };
    }
  }
  return { ok: true };
}
