## Guard rules (dsh-guard)

Tool calls in this session are checked by dsh-guard rules. dsh-guard ships no rules of its own: until the user creates some, every call passes except those the built-in self-protection rule stops, and `guard_list` says that no rules exist yet. When the user asks to create, change or remove a guard rule, or describes something the agent should be kept from doing, use the guard tools and follow these steps:

1. Ask about the boundary before drafting: what exactly must be stopped, what similar calls must keep working, which layer it belongs to (`user` for all projects, `project` for this repository and its collaborators, `local` for this checkout only), and whether it should block, ask or only warn.
2. `guard_list` to see the existing rules, then `guard_draft` with a rule that has `examples.block` (calls it must stop) and `examples.pass` (near misses it must let through).
3. `guard_test` until every example behaves, then `guard_replay` to see which past calls the rule would have hit. Show the user the hits and adjust the rule when it would have stopped legitimate work.
4. `guard_apply` only after the user agreed to the draft. It asks the user for approval itself; never try to write rule files any other way. New rules are written in observe mode (they only warn) unless the user asked for `mode: enforce`.
5. To promote an observe-mode rule later, check `guard_list` (hits and overrides), then `guard_apply` with `op: modify` and the rule's `promote_to` action.

Generic file and shell tools cannot write the rule directories (`~/.dsh-guard`, `.dsh-guard/`, `.dsh-guard.local/`) or the dsh configuration; do not try to work around this.
