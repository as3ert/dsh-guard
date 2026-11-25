/** dsh wording shared by the plugin tools and the command line; imports no dsh packages. @module */

/** Shown by guard_list while no rule file defines any rule. */
export const NO_RULES_TEXT = 'No guard rules exist yet: dsh-guard ships no rules, so every tool call passes except those the built-in self-protection rule stops. '
  + 'The user can describe in this conversation what should be guarded (which calls to block, ask about or warn on, and which similar calls must keep working); '
  + 'turn that into a first rule with guard_propose and guard_apply. The rule object format and a complete example are in the dsh-guard section of the system prompt; do not search the filesystem for a schema.'
