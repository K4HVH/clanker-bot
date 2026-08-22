# Ticket intelligence check

Gate ticket creation behind a short generated reasoning test, so members who cannot
state a problem or follow a simple instruction are pointed at the public support
channel instead of consuming staff time one-on-one.

## Why generated, not a question bank

Three filter designs were considered and rejected:

- **Admin-authored question bank.** Answers get screenshotted into general chat within a
  week, and it puts a permanent content-authoring burden on the owner.
- **Validated intake form.** Improves ticket quality but does not reduce ticket count:
  a low-effort member fills the fields with low-effort text and the ticket still lands.
- **LLM screening.** Strongest filter, but it would be the bot's first external API
  dependency and its first per-action running cost.

Generated questions have no bank to maintain, no answers to share (parameters change
every time), and no external dependency. The cost is that the generators must be
correct: a question with a wrong answer key bounces a *competent* member, which is the
worst failure this feature can have. That is why the generator layer is pure, seeded,
and tested by independently recomputing every answer.

## Scope

Ships one question category, `reasoning`. The category mechanism exists from day one so
domain-specific sets (electronics, ESP32, doc comprehension) are additive later, and so
a harder tier arrives as a new category rather than as a difficulty knob. A captcha-style
1-5 difficulty scale was rejected: there it is one rendering parameter, here it would mean
authoring five calibrated variants of every generator. The bar is set instead by how many
questions are asked, how many must be right, and the time limit.

## Layers

### `src/lib/ticket-check.ts` (pure, no discord.js)

```ts
export type CheckCategory = "reasoning";
export interface CheckQuestion { category, prompt, choices: string[], answerIndex }
export interface Generator { id, category, generate(rng: Rng): CheckQuestion }
```

`Rng` is a seeded mulberry32, crypto-seeded in production and fixed-seed in tests. Every
question is four-option multiple choice. Free-text answers were rejected: "3.3" against
"3.3V" would fail people on formatting, and a false failure is worse than a false pass.

Blind guessing clears the 3-of-3 default 1 time in 64, and the failure cooldown is what
makes brute forcing cost hours rather than seconds.

**Distractors are the feature.** Each generator derives its three wrong options from
specific mistakes (the inverse proportion worked as a direct one, the off-by-one, the
un-halved figure), so a wrong method lands on a plausible button instead of finding no
match. Generators emitting duplicate options are a bug the tests catch.

Eight families under `reasoning`:

| id | shape |
|----|-------|
| `seq` | next term: arithmetic, geometric, alternating, second-difference |
| `inverse-rate` | N machines take T minutes, how long for M |
| `syllogism` | modus tollens and an affirming-the-consequent trap where nothing follows |
| `ordering` | transitive comparisons, asks an extreme or the middle |
| `multi-step` | word problem with a changed-base trap |
| `word-index` | Nth letter of the Mth word, pure careful reading |
| `table-lookup` | two-column table, lookup plus comparison |
| `set-overlap` | inclusion-exclusion |

### `src/db/ticket-check.ts`

```sql
CREATE TABLE ticket_check_results (
  guild_id TEXT, user_id TEXT, passed_at INTEGER, failed_at INTEGER,
  fails INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id)
) WITHOUT ROWID;
```

Holds only what must outlive a restart: the pass timestamp (for the validity window) and
the failure timestamp plus count (for the cooldown, and for the mod-log line). An
in-flight challenge is deliberately *not* persisted; losing one to a restart costs the
member a click.

### `src/modules/tickets/check.ts`

The Discord-facing half: the in-memory session map, gate evaluation, question embeds,
button handlers, and the mod-log embed. It lives beside `index.ts` rather than inside it
because that file is already 873 lines.

Sessions are keyed `guildId:userId` and hold the questions, answers given, the deadline,
and a continuation describing what to do on success:

- `{ kind: "panel" }` from the panel button: show the subject modal.
- `{ kind: "command", subject }` from `/ticket open`: open directly, subject already given.

Starting a session replaces any existing one for that member, so an abandoned check
cannot be resumed alongside a fresh one.

Buttons carry `ticket_check:<token>:<question>:<choice>` and register with the router's
existing `match: "prefix"`. The token is per-session random, so a stale ephemeral message
cannot be replayed into a later session; the question index is validated against the
session's current position so one question cannot be answered twice.

Sessions are swept for expiry inside the existing five-minute ticket scan rather than on
a timer of their own.

## Flow

Both entry points call one gate function, which returns allow / deny / challenge.

Order of checks: **quota first, gate second.** Nobody should pass a test and only then be
told they are at their ticket limit.

Bypasses: staff (`Manage Server` or the ticket staff role) when `exempt staff` is on, any
role in `exempt roles`, and any ticket a staff member opens on someone's behalf with
`/ticket open for:` (staff have already decided that person needs a ticket).

A pass is recorded the moment the last correct answer lands, before the channel is
created, so a Discord failure during creation does not cost the member their pass.

On the final correct answer the button interaction responds with the subject modal
(panel origin) or updates itself and opens the ticket (command origin). Because the modal
is opened from a component, the modal handler uses `deferUpdate` and edits the question
message in place instead of leaving it on screen under a second reply.

On failure the message is replaced with the configured fail text, the failure is recorded,
and a mod-log embed reports who, the score, each question with their answer against the
correct one, their running failure count, and when the cooldown lifts.

A successful open adds one `Check` field to the existing mod-log open embed (score and
elapsed time), which is how the owner tells whether the bar is set right.

## Configuration

New category `Ticket Check`, split out the way Automod is split rather than lengthening
Tickets. All behaviour is registry-driven; nothing about the gate is hardcoded.

| key | type | default |
|-----|------|---------|
| `ticket_check_enabled` | bool | false |
| `ticket_check_categories` | text | `reasoning` |
| `ticket_check_questions` | int 1-5 | 3 |
| `ticket_check_required` | int 1-5 | 3 |
| `ticket_check_seconds` | int 30-600 | 180 |
| `ticket_check_pass_days` | int 0-365 | 30 (0 = every ticket) |
| `ticket_check_cooldown_minutes` | int 1-1440 | 30 |
| `ticket_check_exempt_roles` | text (ID list) | empty |
| `ticket_check_exempt_staff` | bool | true |
| `ticket_check_intro_text` | text | see registry |
| `ticket_check_fail_text` | text | see registry |
| `ticket_check_log_failures` | bool | true |

`required` above `questions` is clamped at read time rather than rejected, so no
combination of the two knobs can produce a gate nobody can pass.

`/ticket check user:<member> [pass:true]` (staff) clears a member's check state so they
can retry immediately, or marks them passed outright. Without it, a gate that wrongly
bounces someone leaves staff no recourse short of turning the feature off.

## Testing

- **Generators**: every family, many seeds. Each test recomputes the expected answer from
  the seeded parameters independently of the generator, and asserts four distinct options,
  an in-range answer index, and a prompt containing the parameters it claims.
- **Gate**: exemptions, pass validity window, cooldown window, question/required clamping,
  disabled feature.
- **DB**: pass and fail records, counters, the staff reset.
- **Session**: token mismatch rejected, replayed question index rejected, expiry.

## Deliberately excluded

- Escalating cooldowns on repeat failures. A flat cooldown already makes brute forcing
  uneconomic; the failure count is stored and logged, so escalation can be added later
  from data rather than from a guess.
- Persisting in-flight sessions across restarts.
- Any per-question difficulty scale (see Scope).
