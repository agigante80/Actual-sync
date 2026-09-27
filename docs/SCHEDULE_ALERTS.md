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
- [De-duplication and reminders](#de-duplication-and-reminders)
- [Digest mode](#digest-mode)
- [Templates](#templates)
- [Variables](#variables)
- [Timezone](#timezone)
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
4. What happened for the most recent occurrence becomes zero or one event: `missing`,
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
| `amountTolerancePct` | number, 0-100 | derived | How far a posted amount may differ from the schedule's expected amount and still be on time. Defaults to Actual's own schedule amount mode: `0` for an exact amount, `7.5` for "approximately". |
| `remindEveryDays` | integer, 1-30 | off | Repeat an unresolved `missing` alert every N days instead of sending it once. |
| `channels` | array of `telegram`\|`email`\|`slack`\|`discord`\|`webhook`\|`ntfy` | every configured channel | Which notification channels this rule uses. A channel with no usable destination configured is silently skipped. |
| `templates` | object | - | Per-rule template overrides. Takes priority over the block-level `templates`. |

## Event types

| Event | When | Notes |
|---|---|---|
| `missing` | No matching transaction by the deadline, and the account is synced past it. | Repeats every `remindEveryDays`, if set. |
| `wrongAmount` | A matching transaction posted in-window, but its amount is outside tolerance. | One-time; not repeated. |
| `cannotCheck` | The account's last sync is stale (`reason: "stale"`), not yet past the deadline (`reason: "not-synced"`), or the rule's own window configuration is unsound (`reason: "interval-violation"`, see below). | Never a false `missing`. |
| `resolved` | A payment previously reported `missing` later posts, on time or late. | Closes out the alert; no manual dismissal needed. |
| `ruleUnmatched` | A rule's `schedule`/`schedulePrefix` matches no schedule in Actual (renamed, deleted, or a typo). | Repeats once per day while unmatched (a fixed interval, independent of the rule's own `remindEveryDays`). |

## De-duplication and reminders

Every event is looked up in the `schedule_alerts` ledger (part of the sync-history SQLite database;
see [SYNC_HISTORY.md](./SYNC_HISTORY.md)) by `(server, alertId, scheduleId, occurrenceDate, event)`
before it is sent. A key that already has a row is not sent again, **except**:

- a `missing` event, when `remindEveryDays` is set and that many days have passed since the latest
  recorded row for that key;
- a `ruleUnmatched` event, which always uses a fixed 1-day interval, regardless of `remindEveryDays`.

A ledger row is written only after a successful send; a failed send (every configured destination
returned a failure, or the send threw) withholds the row so the event is retried on the next sync
rather than silently lost. The ledger is purged along with the rest of sync history, but never
before `max(retentionDays, 120)` days, so alert history outlives a short `retentionDays` setting.

## Digest mode

`scheduleAlerts.digest: true` merges every eligible event from one sync, for one server, into a
single message per channel, instead of one message per event. The ledger still records one row per
event - de-duplication and reminders work exactly as in the non-digest case; only the outgoing
notification is merged. When several destinations of the same channel type are configured (for
example two Slack webhooks), the digest sends to the first enabled one of that type; fan-out to
every configured destination is preserved for the non-digest case.

## Templates

Message wording uses the same [Handlebars](https://handlebarsjs.com/) template engine as the rest
of Actual-sync's notifications (see [NOTIFICATIONS.md](./NOTIFICATIONS.md), "Message templates").
Override any of the five built-in messages (`missing`, `wrongAmount`, `resolved`, `cannotCheck`,
`ruleUnmatched`) under `scheduleAlerts.templates` (block-wide) or `alerts[].templates` (per rule):

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
| `budget` | The server name |
| `alert_id` | The rule's `id` |

## Timezone

Every date computed by this feature - an occurrence date, a deadline, "today", account staleness -
is computed in one timezone: the top-level `timezone` config key, falling back to the host
machine's own local IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) when unset. A
`timezone` config key does not exist yet as of this release, so in practice every server currently
shares the sync process's own local zone.

## Design notes and known limitations

- **Overlapping windows are caught per schedule, at evaluation time, not at config load.** A rule
  whose `graceDays + earlyDays` is greater than or equal to its schedule's own shortest interval
  between occurrences would let one payment satisfy two occurrences, or invert the late window. A
  schedule's cadence is only known once `getSchedules()` returns during a sync - `config.json` alone
  carries no cadence information - so this cannot be rejected at config-load time the way a
  structural error (a missing required field, a duplicate `id`) can. Instead, the violation is
  detected the first time the rule is evaluated: the rule is skipped for that sync (one
  `cannotCheck` event, `reason: "interval-violation"`) and a warning is logged, rather than risk a
  double-counted payment or an inverted late window.
- **A rule requesting a channel with nothing configured to receive it is not an error.** If a rule's
  `channels` names a channel with no usable destination (for example `email` with no SMTP
  configured), that channel is silently dropped rather than failing the whole alert; if every
  requested channel drops out this way, the event is treated as delivered (so it does not retry
  forever waiting for a destination that will never exist) but nothing is actually sent anywhere.
  Configure at least one working destination for a rule's channels to receive it.
- **Rule enable/mute state and dashboard-managed rules are out of scope for this release.** Every
  rule from `config.json` is always enabled and never muted; a future release can add real
  enable/mute state and dashboard-created rules without changing the evaluation or delivery engine.
