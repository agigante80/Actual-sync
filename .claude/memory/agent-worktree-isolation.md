---
name: agent-worktree-isolation
description: Review agents mutate the working tree; concurrent runs corrupt it and produce phantom findings — use a detached worktree
metadata:
  type: feedback
---

Code-review subagents in this repo verify findings by **mutating source files in the working tree** — reintroducing a defect, running the suite, reverting. If a second agent (or the main session) mutates or runs tests at the same time, they clobber each other: one round reported a phantom `SURVIVED` and left a source file permanently mutated, and a reviewer once flagged "a concurrent Claude session is working in this repo" — which was this session running its own mutation battery.

**Do any mutation or destructive verification in a dedicated `git worktree`**, not the main checkout:

```bash
git worktree add --detach /tmp/wt HEAD
ln -s "$(pwd)/node_modules" /tmp/wt/node_modules   # avoid a full reinstall
# ... work ...
git worktree remove --force /tmp/wt && git worktree prune
```

Note `git worktree add <path> development` fails when `development` is already checked out in the main tree — use `--detach HEAD`.

Tell every review subagent explicitly: use your own worktree, never revert files you did not modify, and confirm the tree is clean at the end. Before editing shared files mid-round, check `git status --porcelain` for someone else’s in-flight mutation.

**Why:** concurrent mutation produced corrupted trees and false review findings, which cost a whole round to untangle.
**How to apply:** isolate first, and include the coordination note in every review-agent prompt. Related: [[mutation-testing-standard]].
