# Missing-Payment Alerts

Actual-sync can compare a server's own [Actual schedules](https://actualbudget.org/docs/budgeting/schedules/)
against its posted transactions, once per sync, and notify you when an expected recurring payment
did not behave as expected: it never arrived, it arrived for the wrong amount, or the bank
connection is too stale to tell either way.

This feature has no cadence of its own. Actual's schedule is the single source of truth for *when*
a payment is expected; this feature only adds a grace period, an early-payment allowance, and a
tolerance for how stale a bank connection may be before a missing payment is reported as
unconfirmable instead of missing.

## Table of Contents

- [How it works](#how-it-works)
- [Enabling it](#enabling-it)
- [Configuration reference](#configuration-reference)
- [Event types](#event-types)
- [Switching alerts off and muting](#switching-alerts-off-and-muting)
- [De-duplication and reminders](#de-duplication-and-reminders)
- [Digest mode](#digest-mode)
- [Startup validation](#startup-validation)
- [Templates](#templates)
- [Variables](#variables)
- [Timezone](#timezone)
- [Payment snapshot and the dashboard API](#payment-snapshot-and-the-dashboard-api)
- [Rules from the dashboard](#rules-from-the-dashboard)
- [Design notes and known limitations](#design-notes-and-known-limitations)

## How it works

For each server with a `scheduleAlerts` block:

1. After the bank-sync loop finishes (inside the same sync, the same Actual session), the step
   calls `getSchedules()`, reads posted transactions in a look-back window, and evaluates every
   configured rule against them.
2. Each rule watches one schedule (`schedule: "Rent - Apartment"`) or every schedule whose name
   starts with a prefix (`schedulePrefix: "Rent"`, one alert per match).
3. For every occurrence of a watched schedule, a matching transaction is looked for by two means:
   Actual's own transaction-to-schedule link (authoritative, regardless of amount) or an
   account + payee match within an early/grace window around the occurrence date.
4. What happened for each occurrence in the look-back window (up to 90 days: twice the schedule's longest interval, at least 7) becomes zero or one event
   of its own, so several overdue occurrences can each produce one: `missing`,
   `wrongAmount`, `cannotCheck`, `resolved`, or (for a rule matching no schedule) `ruleUnmatched`.
   See [Event types](#event-types).
5. Each event is de-duplicated against a ledger (the `schedule_alerts` table in the sync-history
   database) before it is rendered and sent, so the same event does not repeat on every sync.

A server with no `scheduleAlerts` block never calls `getSchedules()` - this feature has no cost for
a server not using it. Any error in this step (a lost Actual session, a slow query) is logged at
WARN and never changes the sync's own recorded result; it retries on the next sync.

## Enabling it

Add a `scheduleAlerts` block under a server in `config.json`:

```json
{
  "servers": [
    {
      "name": "Main",
      "url": "http://actual-main:5006",
      "password": "your_password",
      "syncId": "your_sync_id",
      "dataDir": "/app/dataDir_Main_temp",
      "scheduleAlerts": {
        "staleAfterDays": 3,
        "digest": false,
        "alerts": [
          { "id": "rent", "schedule": "Rent - Apartment", "graceDays": 6 },
          { "id": "salary", "schedule": "Salary", "graceDays": 3, "earlyDays": 5, "amountTolerancePct": 0 },
          { "id": "utilities", "schedulePrefix": "Utilities -", "remindEveryDays": 3 }
        ]
      }
    }
  ]
}
```

See `config/config.example.json` for a live example and `config/config.schema.json`
(`$defs.scheduleAlertsBlock` / `$defs.scheduleAlert`) for the authoritative field list.

## Configuration reference

### `scheduleAlerts` (per server)

| Field | Type | Default | Description |
|---|---|---|---|
| `alerts` | array (required, min 1) | - | The rules for this server. See below. |
| `digest` | boolean | `false` | Merge every alert event from one sync into one message per channel. See [Digest mode](#digest-mode). |
| `staleAfterDays` | integer, 0-60 | `3` | How many days old an account's last successful sync may be before a missing payment is reported `cannotCheck` instead of `missing`. Strictly greater than this many days counts as stale. |
| `dateFormat` | string | `"D MMM YYYY"` | moment.js format string used for every date/time template variable. |
| `locale` | string | `"en"` | Locale used when rendering Actual's own cadence wording (the `{{cadence}}` variable). |
| `templates` | object | - | Block-level template overrides, applied to every rule under this block unless a rule overrides the same key itself. See [Templates](#templates). |

### One `alerts[]` entry

Exactly one of `schedule` or `schedulePrefix` is required.

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string, `^[a-z0-9-]{1,64}$` | slug of `schedule`/`schedulePrefix` | Stable alert id; used as the ledger key and must be unique per server (checked at startup). |
| `schedule` | string | - | Exact name of one Actual schedule to watch. |
| `schedulePrefix` | string | - | Watch every schedule whose name starts with this prefix; each match becomes its own occurrence of this rule, sharing its `id`. |
| `graceDays` | integer, 0-60 | `3` | Days after the occurrence date before it counts as overdue (deadline = occurrence + `graceDays`). |
| `earlyDays` | integer, 0-31 | `2` | Days before the occurrence date a matching transaction still counts as on time. |
| `period` | `"occurrence"` \| `"next"` | `"occurrence"` | What `{{period}}` names: the occurrence's own month, or the following month (for a payment due at month end, for the month ahead). |
| `amountTolerancePct` | number, 0-100 | derived | How far a posted amount may differ from the schedule's expected amount and still be on time. The sign must match for an unlinked transaction, in both the on-time and the late window: an outgoing refund of the same size is not the incoming payment and is never reported as a wrong amount or a late payment. A transaction Actual itself linked to the schedule is always trusted. A schedule with amount `0` accepts any sign (a non-zero payment is then a wrong amount). A range amount ("between") accepts the sign of either bound, so a range spanning zero or with a zero bound accepts anything. Defaults to Actual's own schedule amount mode: `0` for an exact amount, `7.5` for "approximately". |
| `remindEveryDays` | integer, 1-30 | off | Repeat an unresolved `missing` alert every N days instead of sending it once. |
| `channels` | array of `telegram`\|`email`\|`slack`\|`discord`\|`webhook`\|`ntfy` | every configured channel | Which notification channels this rule uses. A channel with no usable destination configured is silently skipped. |
| `enabled` | boolean | `true` | `false` switches the alert off permanently: it is still evaluated and shown in the Payments tab, but sends nothing, and the dashboard cannot switch it on. See [Switching alerts off and muting](#switching-alerts-off-and-muting). |
| `templates` | object | - | Per-rule template overrides. Takes priority over the block-level `templates`. |

## Event types

| Event | When | Notes |
|---|---|---|
| `missing` | No matching transaction by the deadline, and the account is synced past it. | Repeats every `remindEveryDays`, if set. |
| `wrongAmount` | A matching transaction posted in-window, but its amount is outside tolerance. | One-time; not repeated. |
| `cannotCheck` | The account's last sync is stale (`reason: "stale"`), not yet past the deadline (`reason: "not-synced"`), the rule's own window configuration is unsound (`reason: "interval-violation"`, see below), or the rule threw while being evaluated (`reason: "error"`). | Never a false `missing`. An account that was never bank-synced (no `last_sync` yet) always gives `cannotCheck` (`reason: "stale"`) until its first sync. The built-in message has its own wording per reason; only `stale` and `not-synced` mention the bank connection. |
| `resolved` | A payment previously reported `missing` later posts, on time or late. | Closes out the alert; no manual dismissal needed. Also sent when a one-off schedule with an open `missing` is marked completed, or any schedule with an open `missing` is deleted in Actual, or a rule's target is edited so it no longer names the schedule (see below). |
| `ruleUnmatched` | A rule's `schedule`/`schedulePrefix` matches no schedule in Actual (renamed, deleted, or a typo). | Sent once per destination while the rule stays unmatched; sent again only after the rule matched a schedule again and later unmatched (see below). |

## Lifecycle of a completed one-off schedule (#326)

Actual drops a schedule marked completed out of the active set, and a completed schedule is never
evaluated for new alerts. A completed **one-off** schedule (a single date, not a recurrence) that has
an open `missing` (including its reminders) in the ledger still gets one `resolved`, so the alert
thread closes instead of staying open forever:

- The `resolved` uses the built-in "marked completed in Actual" wording (`closed_by` is `completed`),
  whether or not a matching transaction exists. Completing a schedule is the signal; no payment is
  looked for.
- Only a `missing` whose occurrence date is inside the 90-day look-back window is closed. An older one
  stays as it is.
- After it is delivered nothing more is sent for that occurrence, unless the schedule is uncompleted (or a
  payment unlinked) and a new `missing` is recorded for it; then the reminders restart and the next close
  is delivered again. A completed one-off that never had a `missing` sends nothing, and a completed
  recurring schedule is unaffected.
- A custom `resolved` template that never mentions `closed_by` is not used for this case: the built-in
  "marked completed in Actual" text is sent instead, so an older template cannot claim a payment
  arrived. A template that compares `closed_by` to quoted values (for example `(eq closed_by "completed")`, in either order) gets the built-in text for any value it does not name; a template that only tests `{{#if closed_by}}` or prints it is used as written. A normal payment `resolved` always uses your template.

## Lifecycle of a deleted schedule (#356)

A schedule deleted in Actual vanishes from the schedule list, so it is never evaluated again. If it left
an open `missing` in the ledger (including its reminders), the alert thread is closed with one `resolved`
per open occurrence and destination:

- The `resolved` uses the built-in "<name> (<expected date>): removed in Actual. Alert closed." wording (`closed_by` is `deleted`).
  It is built from the ledger alone: the schedule is gone, so `name` is the rule's exact `schedule` name
  (the rule's `id` for a `schedulePrefix` rule), and payee, account and amounts are empty.
- Only a `missing` whose occurrence date is inside the 90-day look-back window is closed, and only for
  destinations that received that `missing`. After it is delivered nothing more is sent for that
  occurrence (same rule as for completed schedules).
- Deletion is only inferred when Actual's schedule list was read successfully and is not empty. See
  "An empty schedule list" below.
- A custom `resolved` template that never mentions `closed_by` gets the built-in text here. A template that compares `closed_by` to quoted values (for example `(eq closed_by "completed")`, in either order) gets the built-in text for any value it does not name; a template that only tests `{{#if closed_by}}` or prints it is used as written.
- A rule bound to the deleted schedule by exact name now matches nothing, so it also sends one
  `ruleUnmatched` per destination (not one per sync).

## Lifecycle of a retargeted rule (#373)

When a rule stops naming a schedule it had an open `missing` for, but that schedule still exists in
Actual, it is not a deletion. The alert thread is closed anyway, with one `resolved` per open occurrence
and destination. Two things trigger this:

- the rule's `schedule` or `schedulePrefix` is edited, in the dashboard or in the config file;
- the schedule is renamed in Actual so the rule no longer matches it. This close is final: renaming the
  schedule back, or fixing the rule, does not alert that occurrence again unless `remindEveryDays` is set,
  and a later payment sends no second close.

- The `resolved` uses the built-in "<name> (<expected date>): no longer tracked by this alert rule. Alert closed."
  wording (`closed_by` is `rule_changed`). `name` is the schedule's own current name in Actual.
- It works exactly like the deleted case otherwise: 90-day look-back window, only destinations that
  received the `missing`, nothing more is sent for that occurrence afterwards, and a mute or a disabled
  rule holds the close back the same way.
- It is only inferred when Actual's schedule list was read successfully and is not empty.
- A schedule the rule still names (an exact name, or any name under the prefix, completed ones included) is
  never closed this way.
- The close is matched by rule id. A config rule without an `id` gets one from its schedule name, so
  editing its `schedule` changes the id and no close is sent; give the rule an `id` to keep it stable.
  Deleting a rule sends nothing, but its sent `missing` rows stay in the ledger: a new rule created later
  with the same id and a different target sends one close for those old occurrences.
- The close only goes to destinations the rule still has. If the same edit also removes the channel
  that received the `missing`, that channel never gets a close.
- The same template rules as for the deleted case apply to a custom `resolved`.

## An empty schedule list (#356, #359)

If reading Actual's schedule list fails, the whole alert evaluation is skipped for that sync. An empty
list (or one that is not a list) is treated as just as unreliable, because a transient empty read (a
budget still loading, a partial download) would otherwise read as "every schedule was deleted":

- When at least one rule is configured, rule matching is skipped for that sync. No `ruleUnmatched`,
  no alert, no deletion close and no `ruleMatched` marker is produced, and one WARN says the schedule
  list was empty and alert evaluation was skipped. The dashboard keeps the last good payment snapshot.
- With no rules configured an empty list is a no-op and logs nothing.
- Nothing from earlier syncs is undone: a `ruleUnmatched` already sent stays recorded and a rule that was
  unmatched stays deduped. The next sync that reads a non-empty list evaluates normally.
- Trade-off: if you really delete every schedule, open alerts stay open and no `ruleUnmatched` is sent
  until a schedule exists again.

## Switching alerts off and muting

Besides `enabled: false` in the config file, an operator can switch an alert off, or mute it until a
date with a reason, from the dashboard (see [DASHBOARD.md](DASHBOARD.md#turning-alerts-off-and-muting)).
These are runtime overrides stored in the sync-history database; the config file is never rewritten.
Evaluation is unchanged: every rule is still evaluated and the Payments tab and its snapshot keep
showing the real state. Only delivery changes.

**Precedence:** `enabled: false` in the config wins, then the dashboard override, then the default
(on, not muted). A config-disabled alert cannot be switched on or muted from the dashboard (its old
mute can still be cleared). An override whose alert or server is no longer configured is ignored.

| Rule state | What delivery does with an event | Ledger row |
|---|---|---|
| on, not muted | sends it | `sent` |
| muted | sends nothing, for all five event kinds | `muted`, one per destination and event |
| off (config or switch) | sends nothing | none |

Switching an alert back on delivers what is still open at the next sync. A `muted` row stops the
same event repeating at that destination (reminders write nothing during a mute), and a
`resolved` notice goes only to destinations that were actually told about the `missing` event.

**Mute lifecycle.** A mute lasts until the end of its `mutedUntil` day in the configured
[timezone](#timezone), up to 365 days ahead. Extending it keeps its original start.
- *Early unmute* deletes the alert's held-back `muted` rows and sends no summary.
- *Mute end:* on the first sync after that day, each destination that had at least one event held
  back gets **one** `muteEnded` message (a separate message even in digest mode); a destination with
  nothing held back gets nothing. Events that resolved themselves during the mute (a `missing`
  occurrence that was then paid) are dropped silently and not counted. The covered events are then
  recorded as sent, so a still-open `missing` is not sent a second time, and the mute fields and
  reason are cleared once every destination has its summary. A failed send is retried on the next
  sync, only for the failed destinations. Meanwhile new events are delivered normally, and the tab
  shows "Mute ended, summary pending".
- *Deferred:* if the alert is switched off or config-disabled when the mute ends, the summary waits.
- *Expiry:* 7 days after the end day (counted from the end of that day) the reason and the held-back
  rows are deleted and the mute is cleared even if no summary was sent, so a failing destination
  cannot keep them forever. This runs for every override of the server on each sync and at startup.
- *Retention:* the ledger purge skips `muted` rows of an alert whose mute is still set.

Delivery runs one at a time (inside the sync queue), but the dashboard writes are not queued behind
a sync: a change that lands while a delivery run is in progress takes effect on the
next run, and an early unmute at that moment can leave a few held-back rows or one extra summary.

**Prefix rules.** A `schedulePrefix` rule has one override for the whole rule (keyed by server and
alert id), not one per matched schedule.

## De-duplication and reminders

Every event is looked up in the `schedule_alerts` ledger (part of the sync-history SQLite database;
see [SYNC_HISTORY.md](./SYNC_HISTORY.md)) by `(server, alertId, scheduleId, occurrenceDate, event,
channel)` before it is sent, where `channel` identifies the exact destination: the channel name
alone for a single-destination channel such as `telegram` or `email`, or for a webhook-style channel
such as `slack`/`discord`/`webhook` that can have several destinations, the channel name plus the
operator's configured `name` for that webhook (if any) plus a short non-reversible hash of its URL
(never the URL itself - the ledger is never a place secrets are stored, #295 review round 2, M8).
The hash is always part of the key, so two webhooks of one channel that share a name are still
tracked and retried separately (#297 F3). A key that already has a row is not sent again to that destination, **except**:

- a `missing` event, when `remindEveryDays` is set and that many days have passed since the latest
  recorded row for that destination;

`ruleUnmatched` is not a reminder (#356): it is sent once per destination and stays silent while the rule
keeps matching nothing. When the rule matches a schedule again, the ledger records a `ruleMatched` marker
(`delivery: inferred`, never sent anywhere); the next time the rule matches nothing, `ruleUnmatched` is
sent again. Ledger rows older than the 120-day retention are purged, so a rule unmatched for longer than
that can be reported once more.

Keying the ledger per destination, not just per channel type, means each destination is retried
independently (#295 review, H5): if one of two configured Slack webhooks is down, only its own row
is withheld and it is retried on the next sync, while the other webhook (and every other channel)
keeps recording success and is not resent. A ledger row is written only after a successful send to
that destination; a failed send to a destination withholds only that destination's row. When a
rule's explicit `channels` list resolves to no configured destination, no ledger row is written and
the sync logs a warning instead of counting the event as delivered; such a rule is also rejected at
config-load time so this is caught before the first sync (see "Startup validation" below). The
ledger is purged along with the rest of sync history, but never before `max(retentionDays, 120)`
days, so alert history outlives a short `retentionDays` setting.

## Digest mode

`scheduleAlerts.digest: true` merges every eligible event from one sync, for one server, into a
single message per channel, instead of one message per event. Each rule's own `channels`
restriction is still honored in digest mode: an event is only merged into the channels its rule
allows, never into every configured channel (#295 review, M1). The ledger still records one row per
destination - de-duplication and reminders work exactly as in the non-digest case; only the
outgoing notification is merged. When several destinations of the same channel type are configured
(for example two Slack webhooks), the digest sends to the first enabled one of that type; fan-out to
every configured destination is preserved for the non-digest case.

A digest never silently drops an alert to fit a channel. Telegram (4096 characters, checked on both
the HTML and the plain-text version), Discord (2000) and Slack (40000) have length limits, so for
those channels the digest adds whole events while they fit and records only the events it actually
included, and logs a WARN with the sent and deferred counts. The remaining events stay due and go
out in the next sync's digest. Events never sent to that destination go first, then the ones that
have waited longest since their last send, so daily reminders cannot crowd out the deferred tail.
This means digest lines are ordered by that rule, not by schedule, and the order can change from
sync to sync. The header count always matches what the message contains. A single
event larger than the limit on its own is still sent, truncated with a trailing `…`.

A transient ledger error (for example `SQLITE_BUSY`) never rejects a sync, in digest or immediate
mode (#332). The two kinds of failure are handled differently:

- Read failure (checking whether a destination is due): nothing is sent for the affected unit this
  sync, with a WARN, and it is retried next sync. In digest mode the unit is one channel's whole
  digest, and the other channels still go out. In immediate mode it is the one event, and the
  other events still go out.
- Write failure (recording the row after a successful send): the message already went out, so the
  WARN says the row may be resent next sync, the remaining items, destinations and channels are
  still processed, and that item or destination is not counted as sent. An immediate-mode event
  counts as sent if at least one destination's row was written.

### Delivery budget and send order

Delivery is bounded by a time budget (30 seconds per sync). A send already started is always
finished; once the budget is spent, nothing new is started and the rest waits for the next sync.
Order matters under that cutoff, so no mode lets the same alerts or the same channel use the whole budget on every run:

- **Immediate mode** sends events whose due destination never received them first, then the ones
  that have waited longest since their last send (the same rule digests use for items). A daily
  reminder (`remindEveryDays: 1`) therefore cannot crowd out an alert further down the list. Alerts
  are sent in that order, not in evaluation order, and the order can change from sync to sync.
  Within one event, destinations are also visited in attempt order (the one attempted longest ago
  first, never-attempted first), not configuration order, so a destination that hangs until the
  budget runs out does not keep later destinations from ever getting a row. Events that tie on
  last send are likewise ordered by the oldest attempt among their due destinations, so an event
  that just hung moves behind the ones the budget has not reached yet.
- **Digest mode** visits channels starting with the one attempted longest ago (never-attempted
  first), not in configuration order. A channel that hangs or fails until the budget runs out is
  stamped as attempted, so on the next sync the channels the budget never reached go first and still
  receive the digest. This attempt order is kept in memory, so a restart goes back to the
  configured order, and it only breaks ties: ledger rows still decide what is due.

**Limitation: one-shot runs get no destination rotation.** The attempt order (digest channels and
immediate-mode destinations) lives only in the running process. A one-shot run, such as `npm run
sync` or `--force-run` started from host cron, starts fresh every time, so it always visits channels
and destinations in configured order. If one channel can hang, put the most reliable channel first.
The oldest-last-send ordering of events is unaffected, because it comes from the ledger.

## Startup validation

Config loading fails fast on two classes of mistakes that would otherwise only surface at send time,
mid-sync (#295 review, H6/M2):

- every rule's merged template set (built-in defaults, `scheduleAlerts.templates`, and the rule's own
  `alerts[].templates`) is compiled for every channel the rule can use, so a malformed Handlebars
  template is a config error, not a runtime one that blocks every alert for that server;
- a rule whose explicit `channels` list names no destination that is actually configured (for
  example `channels: ["slack"]` with no Slack webhook set up) is rejected at startup rather than
  silently never sending.

## Templates

Message wording uses the same [Handlebars](https://handlebarsjs.com/) template engine as the rest
of Actual-sync's notifications (see [NOTIFICATIONS.md](./NOTIFICATIONS.md), "Message templates").
Override any of the six built-in messages (`missing`, `wrongAmount`, `resolved`, `cannotCheck`,
`ruleUnmatched`, and `muteEnded`, the one summary sent when a [mute](#switching-alerts-off-and-muting) ends) under `scheduleAlerts.templates` (block-wide) or `alerts[].templates` (per rule):

```json
"scheduleAlerts": {
  "templates": {
    "missing": "⚠️ {{name}}: expected {{expected_amount}} from {{payee}} by {{deadline}}, {{days_overdue}} day(s) overdue."
  },
  "alerts": [ { "id": "rent", "schedule": "Rent - Apartment" } ]
}
```

A template left out keeps its built-in English wording. Every template is validated at startup
against the [variable list below](#variables); an unknown variable, an unregistered helper, or (for
Telegram) literal markup Telegram would reject all fail fast, naming the offending token and line.

Telegram templates have two extra rules: a literal `&` must be written `&amp;` (also `&lt;`, `&gt;`,
`&quot;`), and allowed tags such as `<b>` must be closed. The entities show literally on every other
channel. Links (`<a href="{{url}}">`) are not supported in templates for now. See
[NOTIFICATIONS.md](./NOTIFICATIONS.md#telegram-markup-rules) and its "Links in templates" decision.

## Variables

Every variable is always present in the render context, as `null` when it does not apply to the
current event type, so a template can reference any of them without an `{{#if}}` guard. Each has a
`_raw` counterpart carrying the underlying value (a number, or an unformatted ISO date) for a
template that wants to format it differently.

| Variable | Meaning |
|---|---|
| `name` | The alert's schedule name (or the rule's `id`, for `ruleUnmatched`) |
| `payee` | The schedule's payee name |
| `account` | The schedule's account name |
| `direction` | `expense` or `income`, derived from the expected amount's sign |
| `expected_amount` / `expected_amount_raw` | The schedule's expected amount |
| `expected_date` / `expected_date_raw` | The occurrence's calendar date |
| `deadline` / `deadline_raw` | Occurrence date + `graceDays` |
| `grace_days` | The rule's configured `graceDays` |
| `period` | The occurrence's month, or the following month when `period: "next"` |
| `cadence` | Actual's own recurrence wording (e.g. "Every month on the 5th") |
| `days_overdue` / `days_overdue_raw` | Days past the deadline |
| `received_amount` / `received_amount_raw` | The amount actually received |
| `received_date` / `received_date_raw` | The date the matching transaction posted |
| `difference` / `difference_raw` | `received_amount - expected_amount` (for `wrongAmount`) |
| `last_sync` / `last_sync_raw` | The account's last successful sync date (for `cannotCheck`) |
| `reason` | Why a `cannotCheck` was raised: `stale`, `not-synced`, `interval-violation` or `error` (empty for other events; for `muteEnded`, the reason given for the mute) |
| `closed_by` | `completed` when a `resolved` closes the alert because the one-off schedule was marked completed in Actual, `deleted` when the schedule was removed in Actual, `rule_changed` when the rule's target was edited so it no longer names the schedule (empty otherwise) |
| `muted_from` / `muted_until` | `muteEnded` only: the start and the end date of the mute, in `dateFormat` |
| `events_count` | `muteEnded` only: how many distinct events were held back |
| `events` | `muteEnded` only: the held-back events, each with `event`, `expected_date` and `deadline` (use `{{#each events as \|e\|}}{{e.event}}{{/each}}`) |
| `budget` | The server name |
| `alert_id` | The rule's `id` |

## Timezone

Every date computed by this feature - an occurrence date, a deadline, "today", account staleness -
is computed in one timezone: the top-level `timezone` config key (see
[CONFIG.md](CONFIG.md#timezone-optional)), falling back to the process timezone (`TZ`, else the
system zone), and to `UTC` when that is blank or not a valid IANA name. All servers share it.

## Payment snapshot and the dashboard API

The dashboard's **Payments** tab renders this snapshot: see [DASHBOARD.md](DASHBOARD.md#payments-tab).

Each sync saves what the evaluation concluded, so `GET /api/dashboard/payments` (see
[HEALTH_CHECK.md](HEALTH_CHECK.md)) can answer without a connection to Actual.

**What is persisted** (SQLite sync-history file, tables `payment_alert_status` and
`payment_alert_run`): per watched schedule its rule id, schedule id, name, cadence text, account,
payee, expected amount (integer cents, or a min/max range), next date, deadline, state and up to 6
occurrences; per server the latest run (time, ok, error code, errored-rule count, last success).
This copies schedule, payee and account names and amounts out of the budget; the data is not
encrypted at rest, like the account snapshot. Enable dashboard auth when `scheduleAlerts` is
used: with the default `auth.type: none` the route is open to anyone who can reach the port.

**Replacement rules.** A successful run replaces the server's rows. Rows of disabled or muted
rules are kept, because they are still evaluated. A rule that threw during an otherwise
successful run keeps its previous row (counted in `rulesErrored`); an interval-violation rule is
stored as `cannotCheck` and is not counted as errored. A successful run with zero evaluations
empties the set. A failed run keeps the previous rows and `lastSuccessAt`, and records one error
code: `rules_invalid` (the rules could not be loaded; defensive, startup validation normally
catches it), `actual_read_failed` (reading Actual failed) or `evaluation_failed` (anything else,
including errors that carry their own code such as a phase timeout). Raw error messages are only
logged, never stored or served.

**`lastAlertAt`** is not stored: it is the latest `sent` row (resolved notices included, inferred
skips not) of the `schedule_alerts` ledger, read at request time. The ledger is purged after
`max(retentionDays, 120)` days, so it becomes `null` once the last alert is older than that.

**Erasure.** Removing a rule deletes its row on the next successful run; removing the
`scheduleAlerts` block deletes the server's rows on the next sync; the history reset (one server
or all) deletes them. Rows of a server removed from the config entirely are erased only by a
reset: once its `sync_history` is purged it drops off the dashboard's orphan list, but
`POST /api/dashboard/reset-history` with the typed server name still erases them. The same
holds for the schedule snapshot described below.

## Rules from the dashboard

A server with a `scheduleAlerts` block can also have rules created in the dashboard (the editor is
#268; the API is in [HEALTH_CHECK.md](HEALTH_CHECK.md#payment-rules-262)). An empty block
(`"scheduleAlerts": { "alerts": [] }`) is enough to opt a server in.

- **Same engine.** A dashboard rule is one `alerts[]` entry stored as JSON, validated by the same
  validator as `config.json` and evaluated by the same code with the same block settings (templates,
  digest, `staleAfterDays`, `dateFormat`, `locale`). The same rule gives the same messages.
- **Precedence.** A rule in `config.json` wins over a dashboard rule with the same id: the dashboard
  rule is shown as superseded, is not evaluated, and becomes active again if the config rule is removed.
  A dashboard rule cannot carry `enabled`; the on/off switch and the mute are the
  [alert state](#switching-alerts-off-and-muting), which works the same for both kinds.
- **Export.** Each rule's `definition` is a complete `alerts[]` entry. Copy it into `config.json` to make
  it a config rule, then delete the dashboard copy.
- **Needs a sync first.** The schedule picker reads a snapshot of Actual's schedules (name, cadence,
  amount, account, payee, next date, completed) that each sync saves in its alert step, with no extra call
  to Actual. Until a sync has run on a server, the picker is empty and the preview uses sample values.
- **Preview and test send.** A preview renders one event for a rule with the stored schedule data and
  stand-ins for what only a real occurrence has. A test send delivers it to each configured destination
  and writes no alert history, so it never suppresses or triggers a real alert (5 per minute).
- **A stored rule that stops validating** (for example after an upgrade tightens the schema) is
  skipped with one warning per sync and shown as invalid in the list; the run does not fail.
- **Reading the rules fails** (a database error): the run records `evaluation_failed` and keeps the
  previous snapshot, rather than quietly evaluating config rules only.
- **Erasure.** A history reset deletes the schedule snapshot but keeps the rules, which are
  configuration; delete them with the rule `DELETE` route. The exception is a server removed from the
  config: a reset of that server, or of all history, deletes its rules too (#262, #372), but only
  while configuration writes are allowed (`allowConfigWrites` on and auth not `none`). With writes
  off, the reset keeps them, because the reset route does not require config writes. Rule values
  appear in the configuration audit trail.

## Design notes and known limitations

- **Overlapping windows are caught per schedule, at evaluation time, not at config load.** A rule
  whose `graceDays + earlyDays` is greater than or equal to its schedule's own shortest interval between
  occurrences would let one payment satisfy two occurrences, or invert the late window. A schedule's
  cadence is only known once `getSchedules()` returns during a sync - `config.json` alone carries no
  cadence information - so this cannot be rejected at config-load time the way a structural error (a
  missing required field, a duplicate `id`) can. Instead, the violation is detected the first time
  the rule is evaluated: the rule is skipped for that sync (one `cannotCheck` event, `reason:
  "interval-violation"`) and a warning is logged, rather than risk a double-counted payment or an
  inverted late window. The +/-2 day linked-transaction early allowance does count towards that sum, but
  only for schedules whose shortest interval is longer than the allowance: a weekly rule with
  `graceDays: 5` (5 + 2 >= 7) is rejected, because its on-time window would swallow the next
  occurrence's early linked payment. For intervals of 2 days or less (daily) the allowance is not
  counted, since it would reject every daily schedule on every sync (#297 F4); instead a linked
  payment's early window is clamped to start the day after the previous occurrence's deadline.
- **A rule's `channels` list must name at least one configured destination, checked at config-load
  time (#295 review, M2), and every template is validated at startup only against the channels a
  rule can actually reach (#295 review round 2, M7).** If a rule's explicit `channels` names only
  channels with no usable destination (for example `email` with no SMTP configured), config loading
  fails with an error naming the rule, rather than the rule silently never sending. A rule that
  leaves `channels` unset (defaulting to every configured channel) is not subject to this check: if
  nothing at all is configured server-wide, its events log a warning and record no ledger row at
  send time instead of being treated as delivered. Template validation follows the same resolved
  channel list, so a Telegram-only restriction (for example, no literal `&`/`<` in the rendered
  text) is only enforced for a rule that can actually reach Telegram, never for one restricted to
  slack/email or on a server with no Telegram destination configured.
- **Telling an explicit skip from a miss (#295 review round 2, H2; #297 F1).** Actual advances a
  schedule's `next_date` both when an operator explicitly skips an occurrence and whenever a later
  occurrence gets linked to a posted payment, with no other trace distinguishing the two. Schedule
  alerts therefore remembers the first observation. The first time an unpaid occurrence is past its
  deadline with `next_date` already beyond it and no linked payment dated between the deadline and
  `next_date`, it is a skip: the occurrence is reported `skipped` and a `skipped` row is written to the
  ledger. That decision is honoured on every later sync, even after a February payment moves
  `next_date` on to March, so January is never reported `missing`. The accepted limitation: a skip
  first seen only after a later linked payment already advanced `next_date` (no sync ran in between,
  or schedule alerts was enabled afterwards) looks identical to a real miss and is reported `missing`
  (or `cannotCheck`), which the operator can dismiss. Hiding a genuine miss would be worse than that
  occasional false `missing`. Skip rows live in the same ledger and are purged with it.
- **A new, renamed or rotated webhook destination gets its currently-open alerts re-sent once, but
  not their `resolved` message (#295 review round 2, M8; #297 F3, F6).** The ledger key for a
  webhook-style destination is its configured `name` (if any) plus a short hash of its URL - never
  the URL itself, since the ledger is a plain-text SQLite database and the URL is a secret. Adding a
  webhook, renaming one, or rotating its URL changes its key to one the ledger has never recorded, so
  any alert still open for that destination is delivered once more before settling back into the
  normal per-destination de-duplication and reminder cycle. This is accepted: it is strictly safer
  than storing the secret in the ledger, or silently losing track of an in-flight alert across a
  rename/rotation. The flip side: a `resolved` message goes only to a destination that holds its own
  `missing` row. If the payment arrives before the renamed or rotated destination received its
  re-sent `missing`, that destination gets neither, and the message the old key received is never
  closed by a `resolved`.
  Databases written by a pre-release development build of this feature (ledger keys of the form
  `slack:#ops`, before the hash was always appended) may see one extra re-send of open alerts after
  upgrading; no released version wrote those keys (#297 round 1, L2).
