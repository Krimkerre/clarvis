import { ToolCall } from '../model/ModelProvider';

/**
 * Tool calls a model wrote into its reply as text, rather than sending them as calls.
 *
 * **Found live, 11 September 2026.** `qwen/qwen3-coder-30b-a3b-instruct`, served through
 * OpenRouter, answered "update plan.md" with `<function=listFiles></function></tool_call>`
 * in the body of its reply and no structured call, so the run ended after 0 steps with
 * the markup on screen. The same model made a dozen proper calls earlier that session:
 * this is intermittent, and refusing the model would lose the runs it gets right.
 *
 * Two shapes, both common among open models: Qwen3-Coder's
 * `<function=name><parameter=key>value</parameter></function>`, and the Hermes-style
 * `<tool_call>{"name": …, "arguments": {…}}</tool_call>`. Anything else is left alone —
 * a reply that merely *mentions* a tool has not called it.
 *
 * Pure, with no `vscode` import, so it runs under `node --test`.
 */
export function toolCallsInText(text: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  const add = (name: string, args: unknown) => calls.push({ id: `text-call-${calls.length + 1}`, name, args });

  let rest = text.replace(/<function=([\w.-]+)>([\s\S]*?)<\/function>/g, (_whole: string, name: string, body: string) => {
    const args: Record<string, unknown> = {};
    for (const [, key, value] of body.matchAll(/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
      args[key] = valueOf(value);
    }
    add(name, args);
    return '';
  });

  rest = rest.replace(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g, (whole: string, json: string) => {
    try {
      const parsed = JSON.parse(json) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name !== 'string') return whole;
      const args = typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : (parsed.arguments ?? {});
      add(parsed.name, args);
      return '';
    } catch {
      return whole;
    }
  });

  if (calls.length === 0) return { calls, rest: text };
  // Whatever wrapped the calls is noise once they are calls.
  return { calls, rest: rest.replace(/<\/?tool_call>/g, '').trim() };
}

/** A parameter's value: a number or a boolean when it is exactly one, the text otherwise. */
function valueOf(raw: string): unknown {
  const trimmed = raw.trim();
  return /^(-?\d+(\.\d+)?|true|false)$/.test(trimmed) ? JSON.parse(trimmed) : raw;
}
