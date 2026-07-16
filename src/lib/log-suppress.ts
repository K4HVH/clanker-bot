// Message ids the bot itself deletes on purpose (e.g. a verification code a user
// typed in a channel) so the audit-logging module skips re-posting them — which
// would otherwise echo the code into the member-log and spam it.
export const suppressedDeletions = new Set<string>();

// Record a to-be-deleted message id; auto-forgets after a grace period in case the MessageDelete
// event never arrives (deletion failed / message uncached). The grace must comfortably outlast a
// single delete's own latency — an individual delete of a >14-day message (the /mod purge slow
// path) can sit behind Discord's strict rate limit for several seconds before its event lands.
export function suppressDeletion(messageId: string): void {
  suppressedDeletions.add(messageId);
  setTimeout(() => suppressedDeletions.delete(messageId), 60_000).unref?.();
}
