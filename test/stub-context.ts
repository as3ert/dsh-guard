/** Stub Cordis context recording listeners, guards, tools and prompt sections. */

type Listener = (...args: any[]) => Promise<any>

export interface StubTool {
  name: string
  description: string
  execute(args: Record<string, unknown>, exec: Record<string, unknown>): Promise<unknown>
}

export function stubContext(services: Record<string, unknown> = {}) {
  const listeners: Record<string, { fn: Listener, prepend: boolean }[]> = {}
  const guards: ((exec: object) => unknown)[] = []
  const warnings: string[] = []
  const tools: Record<string, StubTool> = {}
  const sections: { name: string, text: string }[] = []
  const ctx = {
    on(name: string, fn: Listener, options?: boolean | { prepend?: boolean }) {
      const prepend = typeof options === 'boolean' ? options : options?.prepend === true;
      (listeners[name] ??= []).push({ fn, prepend })
      return () => true
    },
    tools: {
      guard(fn: (exec: object) => unknown) { guards.push(fn); return () => {} },
      register(tool: StubTool) { tools[tool.name] = tool; return () => {} },
    },
    logger: { warn(message: string) { warnings.push(message) }, info() {} },
    effect(fn?: () => unknown) { fn?.() },
    get(name: string) { return services[name] },
    inject(deps: string[], callback: (ctx: unknown) => void) {
      if (deps.includes('systemPrompt')) {
        callback({ ...ctx, systemPrompt: { section(section: { name: string, text: string }) { sections.push(section); return () => {} } } })
      }
    },
  }
  return { ctx, listeners, guards, warnings, tools, sections }
}
