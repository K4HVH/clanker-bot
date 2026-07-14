// Message ids the bot itself deletes on purpose (e.g. a verification code a user
// typed in a channel) so the audit-logging module skips re-posting them — which
// would otherwise echo the code into the member-log and spam it.
export const suppressedDeletions = new Set<string>();

// Record a to-be-deleted message id; auto-forgets after a short grace period in
// case the MessageDelete event never arrives (deletion failed / message uncached).
export function suppressDeletion(messageId: string): void {
  suppressedDeletions.add(messageId);
  setTimeout(() => suppressedDeletions.delete(messageId), 10_000).unref?.();
}
