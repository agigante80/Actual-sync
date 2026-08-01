---
name: notification-gate-1-11
description: notifyOnSuccess now really gates every channel; four more bugs found en route; three silent upgrade behaviour changes
metadata:
  type: project
---

v1.11.0 and v1.11.1 shipped on 2026-07-31 (tagged, released, multi-arch image published). They make `notifications.notifyOnSuccess` (`always` / `errors_only` / `never`) actually gate dispatch on every channel — it had existed in the schema for a long time and **gated nothing anywhere**, including Telegram, where `never` produced *more* messages than `always`.

Originated from **#168** (external reporter @Soulplayer, closed as delivered). Verifying that report surfaced four further bugs, all fixed in the same train: **#171** (notifySync logged "sent" when every channel failed), **#172** (a dead Telegram token logged ERROR every 2s forever), **#173** (`/health` and `actual_sync_info` reported different versions), **#174** (`notifications.webhooks.telegram` had never delivered a message). **#175** removed the uncalled `notifyError()`. **#176** (dead MessageFormatter error-formatter family) is still **open**.

**Upgrade hazards for existing configs** — documented in `docs/MIGRATION.md` "Upgrading to 1.11.0":
- `notifyOnSuccess: "never"` now silences **failures** too. The name reads like "never notify on success" (= `errors_only`), which is probably what such a user meant. A startup WARN names every muted channel.
- Every `config.example.json` up to v1.10.1 shipped `telegram.notifyOnSuccess: "errors_only"`, so anyone who seeded from it now gets quieter Telegram. Widest-reaching change; needs no action.
- `email.enabled: true` now **fails startup** without `from` and a non-empty `to`. `CONFIG_STRICT=false` is the escape hatch.
- A legacy `webhooks.telegram` entry now delivers — this can turn a channel **on** that the operator believed was off. Its presence is its enablement, and it is the one channel with no per-entry `notifyOnSuccess`; set it on `notifications.telegram` instead.

**Why:** these are silent behaviour changes on upgrade, and two of them can stop failure alerts reaching someone who does not read the migration guide.
**How to apply:** if a user reports notifications went quiet after upgrading, check for `never` and for a stale `/notify` preference in `data/telegram-preferences.json` before looking anywhere else. Related: [[actual-sync-release-train]], [[mutation-testing-standard]].
