import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { BotDatabase } from "../db/index";
import type { ConfigService } from "../lib/config";
import type { DiscordApi, Upload } from "./api";
import { after, chunk, copyable, type History, type HistoryMessage, readHistory, readThreadCount, sentAt } from "./history";
import { type Live, type RawOnboarding, readLive } from "./live";
import { parsePosted } from "./posts";
import {
  type AutoModBody,
  buildPlan,
  COMMUNITY_ONLY,
  FILTER,
  type ForumBody,
  matchIds,
  NOTIFY,
  type Op,
  type Plan,
  parseEmoji,
  prepass,
  VERIFICATION,
} from "./plan";
import { isPanel, panelMessage } from "../lib/panels";
import { describeOp } from "./render";
import type { ServerSpec, SettingValue } from "./spec";
import { dropState, loadState, putState, type State, stateKey } from "./state";

export interface ApplyEnv {
  api: DiscordApi;
  db: BotDatabase;
  config: ConfigService;
  guildId: string;
  spec: ServerSpec;
  reason: string; // shown in Discord's audit log on every change
  download?: (url: string) => Promise<Uint8Array>; // a retired channel's files, to upload again
}

interface RawPanelMessage {
  id: string;
  author: { id: string };
  embeds?: { description?: string; color?: number }[];
  components?: { components?: { custom_id?: string }[] }[];
}

async function fetchFile(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`couldn't download ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export interface ApplyResult {
  done: number;
  failed: { op: Op; error: string; hint: string } | null;
  remaining: number;
}

// What to do about a write Discord refused, by its error code: fix the cause and plan again, or make
// the change by hand.
export function failureHint(op: Op, error: unknown, spec: ServerSpec): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const byHand = `Or do it by hand: ${describeOp(op, spec)}`;
  switch (code) {
    case 50001:
    case 50013:
      return "The bot lacks a permission for this. In Server Settings > Roles, give the bot's role Administrator and drag it to the top, then plan again.";
    case 50035:
      return `Discord refused a value from the spec. Check it, then plan again. ${byHand}`;
    case 50074:
      return "Community needs this channel (its rules or updates channel). Pick another in Server Settings > Community > Overview, then plan again.";
    case 30013:
    case 30005:
      return "Discord's limit on channels or roles is reached. Delete some, then plan again.";
    case 10003:
    case 10011:
    case 10008:
      return "Something was deleted while this ran. Plan again.";
    case 40005:
      return "A file in that message is bigger than the bot may upload to this server. Keep the file somewhere else, delete the message, then plan again.";
    default:
      return `Plan again. If it fails the same way: ${byHand.slice(4)}`;
  }
}

// Read the server and plan against it. The bot command and the local command both start here.
export async function planFor(env: Omit<ApplyEnv, "reason">, deletions: boolean, prune = false): Promise<Plan> {
  const state = loadState(env.db, env.guildId);
  const posted = [...state.entries()].filter(([k]) => k.startsWith("post:") && !k.endsWith("#menu")).map(([, v]) => parsePosted(v));
  const postIds = posted.map((p) => ({ channelId: p.channel, messageId: p.message }));
  const threadIds = posted.filter((p) => p.forum !== undefined).map((p) => p.channel);
  const live = await readLive(env.api, env.guildId, postIds, threadIds);
  const input = { spec: env.spec, live, state, settings: env.config.all(env.guildId), deletions, prune };
  const { retired, panels } = prepass(input);
  if (retired.length === 0 && panels.length === 0) return buildPlan(input);
  const histories = new Map<string, History>();
  for (const id of retired) {
    histories.set(id, { messages: await readHistory(env.api, id), threads: await readThreadCount(env.api, env.guildId, id) });
  }
  // A panel posted by hand is the bot's message that isPanel recognises, among the channel's last 50.
  const found = new Map<string, { channel: string; message: string; text: string | null }>();
  for (const { key, kind, channelId } of panels) {
    const recent = await env.api.get<RawPanelMessage[]>(`/channels/${channelId}/messages?limit=50`);
    const m = recent.find((x) => x.author.id === live.botId && isPanel(kind, x));
    if (m) found.set(key, { channel: channelId, message: m.id, text: m.embeds?.[0]?.description ?? null });
  }
  return buildPlan({ ...input, histories, panels: found });
}

// The order operations run in, whatever order the plan lists them: what a later step names must
// exist first (a role before an overwrite for it, a channel before Community points at it), and
// deletions go last, children before parents.
const PHASE: Record<Op["t"], number> = {
  bind: 0,
  "role.create": 1,
  "role.update": 1,
  "role.order": 2,
  "channel.create": 3,
  "channel.update": 3,
  "channel.order": 4,
  "overwrite.set": 5,
  "overwrite.delete": 5,
  "guild.update": 6,
  "asset.set": 7,
  community: 8,
  "automod.create": 9,
  "automod.update": 9,
  "setting.set": 10,
  "post.create": 11,
  "post.edit": 11,
  "post.title": 11,
  "post.delete": 11,
  "automod.delete": 12,
  "channel.backup": 11,
  // After the posts and copies, so onboarding Discord refuses holds up nothing else.
  "onboarding.set": 11.5,
  "channel.delete": 13,
  "role.delete": 14,
  "role.grant": 14.5,
  prune: 15,
};

const bucketOf = (type: number) => (type === 4 ? "category" : type === 2 || type === 13 ? "voice" : "text");

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

// Announcement and stage channels exist only on Community servers, so they come after Community is
// turned on; channel order waits for them.
const rank = (op: Op): number => {
  if (op.t === "channel.create" && COMMUNITY_ONLY.has(op.type)) return PHASE.community + 0.5;
  // A role's new permissions wait for the channels' overwrites, so a run that stops part way never
  // leaves the role widened over channels not yet closed to it.
  if (op.t === "role.update" && op.flags.includes("widens")) return PHASE["overwrite.set"] + 0.5;
  if (op.t === "channel.order") return PHASE.community + 0.7;
  if (op.t === "channel.update" && op.changes.some((c) => c.field === "type")) return PHASE.community + 0.3;
  if (op.t === "prune" && op.kind === "role") return PHASE.prune + 0.5;
  return PHASE[op.t];
};

export async function applyPlan(env: ApplyEnv, plan: Plan): Promise<ApplyResult> {
  const ops = plan.ops.map((op, i) => ({ op, i })).sort((a, b) => rank(a.op) - rank(b.op) || a.i - b.i).map((x) => x.op);
  const runner = new Runner(env, loadState(env.db, env.guildId), await readLive(env.api, env.guildId, []));
  let done = 0;
  for (const op of ops) {
    try {
      await runner.run(op);
      done++;
    } catch (error) {
      return {
        done,
        failed: { op, error: error instanceof Error ? error.message : String(error), hint: failureHint(op, error, env.spec) },
        remaining: ops.length - done,
      };
    }
  }
  return { done, failed: null, remaining: 0 };
}

class Runner {
  constructor(
    private readonly env: ApplyEnv,
    private readonly state: State,
    private readonly live: Live,
  ) {}

  private get g(): `/guilds/${string}` {
    return `/guilds/${this.env.guildId}`;
  }

  private put(kind: Parameters<typeof putState>[2], key: string, id: string): void {
    putState(this.env.db, this.env.guildId, kind, key, id);
    this.state.set(stateKey(kind, key), id);
  }

  private drop(kind: Parameters<typeof dropState>[2], key: string): void {
    dropState(this.env.db, this.env.guildId, kind, key);
    this.state.delete(stateKey(kind, key));
  }

  private need(kind: "role" | "channel" | "automod" | "post", key: string): string {
    const id = this.state.get(stateKey(kind, key));
    if (id === undefined) throw new Error(`no ${kind} for key "${key}"`);
    return id;
  }

  role(key: string): string {
    if (key === "everyone") return this.env.guildId;
    if (key === "bot" || key === "booster") {
      const r = this.live.roles.find((x) => (key === "bot" ? x.botId === this.live.botId : x.booster));
      if (!r) throw new Error(`this server has no ${key === "bot" ? "bot" : "booster"} role`);
      return r.id;
    }
    return this.need("role", key);
  }

  channel(key: string): string {
    return this.need("channel", key);
  }

  // One message as its author wrote it, under a line naming them and when; files uploaded again,
  // and no one pinged. A message that fails part way is taken back, so a rerun posts it once.
  private async copy(into: string, m: HistoryMessage): Promise<void> {
    const { api, reason } = this.env;
    const download = this.env.download ?? fetchFile;
    const who = m.author.global_name ?? m.author.username ?? m.author.id;
    const forwarded = (m.message_snapshots ?? []).map((s) => s.message);
    const lines = [
      `-# ${who}, <t:${sentAt(m)}:f>`,
      m.content,
      ...forwarded.flatMap((f) => ["[forwarded]", f.content]),
      m.poll ? `[poll: ${m.poll.question.text ?? ""}]` : "",
      (m.flags ?? 0) & 32768 ? "[a component message, which can't be copied]" : "",
      (m.sticker_items ?? []).map((s) => `[sticker: ${s.name}]`).join(" "),
    ];
    const parts = chunk(lines.filter((s) => s !== "").join("\n"));
    const files: Upload[] = [];
    for (const a of [...(m.attachments ?? []), ...forwarded.flatMap((f) => f.attachments ?? [])]) {
      files.push({ name: a.filename, data: await download(a.url) });
    }
    const embeds = (m.embeds ?? []).filter((e) => e.type === "rich").map(({ type, video, provider, ...rest }) => rest);
    const flags = (m.flags ?? 0) & 4; // links shown without previews stay that way
    const posts: { content: string; files?: Upload[]; embeds?: Record<string, unknown>[] }[] = parts.map((content) => ({ content }));
    const last = posts.at(-1)!;
    if (files.length > 0) last.files = files.slice(0, 10);
    if (embeds.length > 0) last.embeds = embeds.slice(0, 10);
    for (let i = 10; i < files.length; i += 10) posts.push({ content: "", files: files.slice(i, i + 10) });
    const sent: string[] = [];
    try {
      for (const p of posts) {
        const body = { content: p.content, allowed_mentions: { parse: [] }, ...(flags ? { flags } : {}), ...(p.embeds ? { embeds: p.embeds } : {}) };
        sent.push((await api.post<{ id: string }>(`/channels/${into}/messages`, body, reason, p.files)).id);
      }
    } catch (error) {
      for (const id of sent) await api.delete(`/channels/${into}/messages/${id}`, reason).catch(() => {});
      throw error;
    }
  }

  private optionalChannel(key: unknown): string | null {
    return key === null || key === undefined ? null : this.channel(String(key));
  }

  async run(op: Op): Promise<void> {
    const { api, reason } = this.env;
    switch (op.t) {
      case "bind":
        this.put(op.kind, op.key, op.id);
        if (op.replaces !== undefined && op.kind !== "asset") this.drop(op.kind, op.replaces);
        return;
      case "role.create": {
        const r = await api.post<{ id: string }>(
          `${this.g}/roles`,
          { name: op.name, color: op.color, hoist: op.hoist, mentionable: op.mentionable, permissions: String(op.permissions) },
          reason,
        );
        this.put("role", op.key, r.id);
        return;
      }
      case "role.update": {
        const body: Record<string, unknown> = {};
        for (const c of op.changes) body[c.field] = c.field === "permissions" ? String(c.to) : c.to;
        await api.patch(`${this.g}/roles/${this.role(op.key)}`, body, reason);
        return;
      }
      case "role.delete":
        await api.delete(`${this.g}/roles/${this.role(op.key)}`, reason);
        this.drop("role", op.key);
        return;
      case "role.order": {
        // Permute the positions these roles already hold, so roles the spec doesn't manage, and
        // the bot's, keep theirs.
        const roles = await api.get<{ id: string; position: number }[]>(`${this.g}/roles`);
        const ids = op.keys.map((k) => this.role(k));
        const slots = ids.map((id) => roles.find((r) => r.id === id)!.position).sort((a, b) => b - a);
        await api.patch(`${this.g}/roles`, ids.map((id, i) => ({ id, position: slots[i] })), reason);
        return;
      }
      case "channel.create": {
        const textLike = op.type === 0 || op.type === 5 || op.type === 15 || op.type === 16;
        const body: Record<string, unknown> = {
          name: op.name,
          type: op.type,
          permission_overwrites: op.overwrites.map((o) => ({ id: this.role(o.target), type: 0, allow: String(o.allow), deny: String(o.deny) })),
        };
        if (op.parent !== null) body.parent_id = this.channel(op.parent);
        // Discord takes 1024 characters of topic on create; a forum's longer guidelines follow.
        const lateTopic = textLike && op.topic !== null && op.topic.length > 1024 ? op.topic : null;
        if (textLike && op.topic !== null && lateTopic === null) body.topic = op.topic;
        if (op.forum) Object.assign(body, this.forumFields(op.forum, null));
        if (op.type !== 4) {
          body.rate_limit_per_user = op.slowmode;
          body.nsfw = op.nsfw;
        }
        const c = await api.post<{ id: string }>(`${this.g}/channels`, body, reason);
        this.put("channel", op.key, c.id);
        // Discord drops a forum's flags (require a tag) on create; a modify sets them.
        const late: Record<string, unknown> = {};
        if (lateTopic !== null) late.topic = lateTopic;
        if (body.flags !== undefined) late.flags = body.flags;
        if (Object.keys(late).length > 0) await api.patch(`/channels/${c.id}`, late, reason);
        return;
      }
      case "channel.update": {
        const body: Record<string, unknown> = {};
        const forum: ForumBody = {};
        for (const c of op.changes) {
          if (["tags", "requireTag", "reaction", "sort", "layout", "threadSlowmode"].includes(c.field)) {
            (forum as Record<string, unknown>)[c.field] = c.to;
            continue;
          }
          if (c.field === "type") body.type = c.to === "announcement" ? 5 : 0;
          else if (c.field === "topic") body.topic = c.to === "" ? null : c.to;
          else if (c.field === "slowmode") body.rate_limit_per_user = c.to;
          else if (c.field === "parent") body.parent_id = this.optionalChannel(c.to);
          else body[c.field] = c.to;
        }
        const id = this.channel(op.key);
        if (Object.keys(forum).length > 0) Object.assign(body, this.forumFields(forum, this.live.channels.find((x) => x.id === id)?.forum ?? null));
        await api.patch(`/channels/${id}`, body, reason);
        return;
      }
      case "channel.delete": {
        const id = this.channel(op.key);
        const retired = this.env.spec.retired?.some((r) => r.key === op.key);
        if (retired) {
          // Whatever arrived after the plan read the channel would go with it.
          const since = this.state.get(stateKey("backup", op.key)) ?? "0";
          const left = (await readHistory(api, id, since)).filter(copyable).length;
          if (left > 0) {
            throw new Error(`#${op.name} has ${left} message${left === 1 ? "" : "s"} the plan didn't copy. Plan again to copy ${left === 1 ? "it" : "them"} before the channel goes`);
          }
          const threads = await readThreadCount(api, this.env.guildId, id);
          if (threads > 0) throw new Error(`#${op.name} has ${threads} thread${threads === 1 ? "" : "s"} the plan didn't see. Plan again`);
        }
        await api.delete(`/channels/${id}`, reason);
        // Done: a channel that takes the name later isn't retired again.
        if (retired && !this.state.has(stateKey("backup", op.key))) this.put("backup", op.key, "0");
        this.drop("channel", op.key);
        return;
      }
      case "role.grant": {
        // Members already holding it are skipped, so a run that stops part way carries on next time.
        const role = this.role(op.key);
        let after = "0";
        for (;;) {
          const page = await api.get<{ user: { id: string; bot?: boolean }; roles: string[] }[]>(`${this.g}/members?limit=1000&after=${after}`);
          for (const m of page) {
            if (!m.user.bot && !m.roles.includes(role)) await api.put(`${this.g}/members/${m.user.id}/roles/${role}`, undefined, reason);
          }
          if (page.length < 1000) break;
          after = page[page.length - 1]!.user.id;
        }
        this.put("grant", op.key, "done");
        return;
      }
      case "onboarding.set": {
        // Questions and answers keep the ids they have (members' choices hang off them): matched
        // by title, then a renamed one by its place. Ids Discord doesn't know mark new ones.
        const live = await api.get<RawOnboarding>(`${this.g}/onboarding`);
        let fresh = 0;
        const prompts = matchIds(op.body.prompts, live.prompts, () => String(++fresh)).map(([p, id, was]) => ({
          id,
          type: p.type,
          title: p.title,
          single_select: p.single,
          required: p.required,
          in_onboarding: p.inOnboarding,
          options: matchIds(p.options, was?.options ?? [], () => String(++fresh)).map(([o, optionId]) => ({
            id: optionId,
            title: o.title,
            description: o.description,
            ...parseEmoji(o.emoji),
            emoji_animated: false,
            role_ids: o.roles.map((k) => this.role(k)),
            channel_ids: o.channels.map((k) => this.channel(k)),
          })),
        }));
        const body = { enabled: op.body.enabled, mode: op.body.mode, default_channel_ids: op.body.defaultChannels.map((k) => this.channel(k)), prompts };
        await api.put(`${this.g}/onboarding`, body, reason);
        return;
      }
      case "channel.backup": {
        const source = this.channel(op.key);
        const into = this.channel(op.into);
        const name = this.live.channels.find((c) => c.id === source)?.name ?? op.key;
        if (op.from === null) {
          await api.post(`/channels/${into}/messages`, { content: `# ${name}`, allowed_mentions: { parse: [] } }, reason);
          this.put("backup", op.key, "0");
        }
        const since = this.state.get(stateKey("backup", op.key)) ?? "0";
        for (const m of await readHistory(api, source, since)) {
          if (after(m.id, op.upTo)) break;
          if (copyable(m)) {
            try {
              await this.copy(into, m);
            } catch (error) {
              const { message, code, status } = error as { message?: string; code?: unknown; status?: unknown };
              throw Object.assign(new Error(`Message ${m.id} in #${name}: ${message ?? String(error)}`), { code, status });
            }
          }
          this.put("backup", op.key, m.id);
        }
        return;
      }
      case "channel.order": {
        // As for roles: within each parent and bucket, permute the positions the channels hold.
        const live = await api.get<{ id: string; type: number; position: number }[]>(`${this.g}/channels`);
        const groups = new Map<string, string[]>();
        for (const item of op.items) {
          const id = this.channel(item.key);
          const c = live.find((x) => x.id === id);
          if (!c) continue;
          const g = `${item.parent ?? ""}/${bucketOf(c.type)}`;
          groups.set(g, [...(groups.get(g) ?? []), id]);
        }
        const body: { id: string; position: number }[] = [];
        for (const ids of groups.values()) {
          const slots = ids.map((id) => live.find((x) => x.id === id)!.position).sort((a, b) => a - b);
          ids.forEach((id, i) => body.push({ id, position: slots[i]! }));
        }
        if (body.length > 0) await api.patch(`${this.g}/channels`, body, reason);
        return;
      }
      case "overwrite.set":
        await api.put(
          `/channels/${this.channel(op.channel)}/permissions/${this.role(op.target)}`,
          { type: 0, allow: String(op.allow), deny: String(op.deny) },
          reason,
        );
        return;
      case "overwrite.delete": {
        const target = op.target.startsWith("member:") ? op.target.slice(7) : this.role(op.target);
        await api.delete(`/channels/${this.channel(op.channel)}/permissions/${target}`, reason);
        return;
      }
      case "guild.update": {
        const body: Record<string, unknown> = {};
        for (const c of op.changes) {
          switch (c.field) {
            case "verificationLevel":
              body.verification_level = VERIFICATION.indexOf(c.to as (typeof VERIFICATION)[number]);
              break;
            case "explicitContentFilter":
              body.explicit_content_filter = FILTER.indexOf(c.to as (typeof FILTER)[number]);
              break;
            case "defaultNotifications":
              body.default_message_notifications = NOTIFY.indexOf(c.to as (typeof NOTIFY)[number]);
              break;
            case "systemChannel":
              body.system_channel_id = this.optionalChannel(c.to);
              break;
            case "safetyAlertsChannel":
              body.safety_alerts_channel_id = this.optionalChannel(c.to);
              break;
            case "rulesChannel":
              body.rules_channel_id = this.optionalChannel(c.to);
              break;
            case "updatesChannel":
              body.public_updates_channel_id = this.optionalChannel(c.to);
              break;
            default:
              body[c.field] = c.to;
          }
        }
        // Discord ignores a new rules or updates channel unless the feature list comes with it.
        if ("rules_channel_id" in body || "public_updates_channel_id" in body) {
          body.features = (await api.get<{ features: string[] }>(this.g)).features;
        }
        await api.patch(this.g, body, reason);
        return;
      }
      case "asset.set": {
        const file = join(this.env.spec.dir, op.file);
        const mime = MIME[extname(file).toLowerCase()] ?? "image/png";
        const data = `data:${mime};base64,${readFileSync(file).toString("base64")}`;
        await api.patch(this.g, { [op.key]: data }, reason);
        this.put("asset", op.key, op.hash);
        return;
      }
      case "community": {
        const guild = await api.get<{ features: string[] }>(this.g);
        const others = guild.features.filter((f) => f !== "COMMUNITY");
        const community = this.env.spec.guild.community;
        if (op.enable && community) {
          await api.patch(
            this.g,
            { features: [...others, "COMMUNITY"], rules_channel_id: this.channel(community.rules), public_updates_channel_id: this.channel(community.updates) },
            reason,
          );
        } else {
          await api.patch(this.g, { features: others }, reason);
        }
        return;
      }
      case "automod.create": {
        // A server has one spam and one mention-spam rule at most, and Discord makes the mention-spam
        // one itself when Community comes on: one already there is taken over and set to the file.
        if (op.body.trigger !== 1) {
          const rules = await api.get<{ id: string; trigger_type: number }[]>(`${this.g}/auto-moderation/rules`);
          const there = rules.find((r) => r.trigger_type === op.body.trigger);
          if (there) {
            await api.patch(`${this.g}/auto-moderation/rules/${there.id}`, this.ruleBody(op.body), reason);
            this.put("automod", op.key, there.id);
            return;
          }
        }
        const r = await api.post<{ id: string }>(`${this.g}/auto-moderation/rules`, { ...this.ruleBody(op.body), event_type: 1, trigger_type: op.body.trigger }, reason);
        this.put("automod", op.key, r.id);
        return;
      }
      case "automod.update":
        await api.patch(`${this.g}/auto-moderation/rules/${this.need("automod", op.key)}`, this.ruleBody(op.body), reason);
        return;
      case "automod.delete":
        await api.delete(`${this.g}/auto-moderation/rules/${this.need("automod", op.key)}`, reason);
        this.drop("automod", op.key);
        return;
      case "setting.set": {
        const value = this.settingValue(op.value);
        if (value === undefined) this.env.config.unset(this.env.guildId, op.key);
        else this.env.config.set(this.env.guildId, op.key, value);
        return;
      }
      case "post.create": {
        const message = op.panel
          ? { ...panelMessage(op.panel.kind, op.panel.text), allowed_mentions: { parse: [] } }
          : { content: this.fill(op.content), allowed_mentions: { parse: [] }, ...(op.components ? { components: op.components } : {}) };
        if (op.thread) {
          // A forum post: its first chunk starts the thread, whose first message has the thread's id.
          const forumId = this.channel(op.channel);
          const t = await api.post<{ id: string; message?: { id: string } }>(
            `/channels/${forumId}/threads`,
            { name: op.thread.title, message },
            reason,
          );
          if (op.thread.pin) await api.patch(`/channels/${t.id}`, { flags: 2 }, reason);
          this.put("post", `${op.key}#${op.index}`, `${t.id}/${t.message?.id ?? t.id}@${forumId}`);
        } else {
          const first = op.index > 0 ? this.state.get(stateKey("post", `${op.key}#0`)) : undefined;
          const inThread = first !== undefined ? parsePosted(first) : undefined;
          const channelId = inThread?.forum !== undefined ? inThread.channel : this.channel(op.channel);
          const m = await api.post<{ id: string }>(`/channels/${channelId}/messages`, message, reason);
          const forum = inThread?.forum !== undefined ? `@${inThread.forum}` : "";
          this.put("post", `${op.key}#${op.index}`, `${channelId}/${m.id}${forum}`);
        }
        if (op.menuHash) this.put("post", `${op.key}#menu`, op.menuHash);
        return;
      }
      case "post.edit": {
        const at = parsePosted(this.need("post", `${op.key}#${op.index}`));
        const components = op.components ?? (op.clearMenu ? [] : undefined);
        const body = op.panel
          ? { content: "", ...panelMessage(op.panel.kind, op.panel.text), allowed_mentions: { parse: [] } }
          : { content: this.fill(op.content), allowed_mentions: { parse: [] }, ...(components ? { components } : {}) };
        await api.patch(`/channels/${at.channel}/messages/${at.message}`, body, reason);
        if (op.menuHash) this.put("post", `${op.key}#menu`, op.menuHash);
        else if (op.clearMenu) this.drop("post", `${op.key}#menu`);
        return;
      }
      case "post.title": {
        const at = parsePosted(this.need("post", `${op.key}#0`));
        await api.patch(`/channels/${at.channel}`, { name: op.title, flags: op.pin ? 2 : 0 }, reason);
        return;
      }
      case "prune":
        await api.delete(op.kind === "channel" ? `/channels/${op.id}` : `${this.g}/roles/${op.id}`, reason);
        return;
      case "post.delete": {
        const at = parsePosted(this.need("post", `${op.key}#${op.index}`));
        // A forum post's first chunk is its thread: deleting the thread deletes the post.
        const route: `/${string}` = at.forum !== undefined && op.index === 0 ? `/channels/${at.channel}` : `/channels/${at.channel}/messages/${at.message}`;
        try {
          await api.delete(route, reason);
        } catch (error) {
          // Already gone by hand: the state row is all that's left to remove.
          if ((error as { status?: number }).status !== 404) throw error;
        }
        this.drop("post", `${op.key}#${op.index}`);
        return;
      }
      default: {
        const unhandled: never = op;
        throw new Error(`no way to apply ${(unhandled as Op).t}`);
      }
    }
  }

  // A post's "{#key}" channel names left for a channel this run created.
  private fill(text: string): string {
    return text.replace(/\{#([a-z0-9-]+)\}/g, (_all, key: string) => `<#${this.channel(key)}>`);
  }

  // A forum's settings in Discord's field names. Tags keep the ids of same-named tags the channel
  // already has, so threads tagged with them stay tagged.
  private forumFields(f: ForumBody, live: { flags: number; tags: { id: string; name: string }[] } | null): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (f.tags) {
      out.available_tags = f.tags.map((t) => {
        const id = live?.tags.find((l) => l.name === t.name)?.id;
        return { ...(id ? { id } : {}), name: t.name, moderated: t.moderated, emoji_id: null, emoji_name: t.emoji };
      });
    }
    if (f.requireTag !== undefined) out.flags = ((live?.flags ?? 0) & ~16) | (f.requireTag ? 16 : 0);
    if (f.reaction !== undefined) out.default_reaction_emoji = f.reaction === null ? null : { emoji_id: null, emoji_name: f.reaction };
    if (f.sort !== undefined) out.default_sort_order = f.sort;
    if (f.layout !== undefined) out.default_forum_layout = f.layout;
    if (f.threadSlowmode !== undefined) out.default_thread_rate_limit_per_user = f.threadSlowmode;
    return out;
  }

  private ruleBody(b: AutoModBody): Record<string, unknown> {
    return {
      name: b.name,
      enabled: b.enabled,
      trigger_metadata:
        b.trigger === 1
          ? { keyword_filter: b.keywords, regex_patterns: b.regex, allow_list: b.allow }
          : b.trigger === 5
            ? { mention_total_limit: b.mentionLimit, mention_raid_protection_enabled: b.raidProtection }
            : {},
      actions: b.actions.map((a) => {
        if (a.type === 1) return { type: 1, metadata: a.message === undefined ? {} : { custom_message: a.message } };
        if (a.type === 2) return { type: 2, metadata: { channel_id: this.channel(a.channel!) } };
        return { type: 3, metadata: { duration_seconds: a.seconds } };
      }),
      exempt_roles: b.exemptRoles.map((k) => this.role(k)),
      exempt_channels: b.exemptChannels.map((k) => this.channel(k)),
    };
  }

  private settingValue(v: SettingValue): unknown {
    if (v === null) return undefined;
    if (typeof v === "object" && !Array.isArray(v)) {
      if ("channel" in v) return this.channel(v.channel);
      if ("role" in v) return this.role(v.role);
      return v.roles.map((k) => this.role(k));
    }
    return typeof v === "string" ? this.fill(v) : v;
  }
}



// The Apply result as the owner reads it: what was done, where it stopped and why, and every change
// left for them to make by hand.
export function applySummary(result: ApplyResult, plan: Plan, spec: ServerSpec): string {
  const lines = [`Applied ${result.done} change${result.done === 1 ? "" : "s"}.`];
  if (result.failed) {
    lines.push(
      "",
      `Stopped at: ${describeOp(result.failed.op, spec)}`,
      `Discord said: ${result.failed.error}`,
      result.failed.hint,
      `${result.remaining} change${result.remaining === 1 ? "" : "s"} not applied.`,
    );
  }
  if (plan.manual.length > 0) lines.push("", "Manual steps:", ...plan.manual.map((m) => `- ${m}`));
  return lines.join("\n");
}
