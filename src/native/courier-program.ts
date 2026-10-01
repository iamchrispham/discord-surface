// Deterministic courier forwarding mode.
//
// The producer no longer asks the model to transcribe the admitted payload. It
// emits one fenced JavaScript program that reads the exact persisted tool input
// through the installed CLI and forwards that parsed object unchanged. The raw
// prompt and wire never appear in the program text.

const INSTRUCTION = 'Run this program once with functions.exec. Do not transcribe the payload, call another tool, acknowledge, answer or retry. Stop after the tool result.';

const EXEC_COMMAND = 'exec_command';
const SEND_COMMAND = 'mcp__codex_app__send_message_to_thread';

// POSIX single-quote shell quoting: every byte is literal and each apostrophe is
// closed, escaped and reopened. The assembled command is passed as one argument.
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

function programBody(argv: readonly string[]): string {
  const command = argv.map(shellQuote).join(' ');
  return [
    `const command = ${JSON.stringify(command)};`,
    `const result = await tools.${EXEC_COMMAND}({ cmd: command, yield_time_ms: 10000, max_output_tokens: 32000 });`,
    "if (!result || result.exit_code !== 0 || result.session_id != null || result.running === true || (result.status !== undefined && result.status !== 'completed')) {",
    "  throw new Error('courier input reader did not complete');",
    '}',
    'const parsed = JSON.parse(result.output);',
    "if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {",
    "  throw new Error('courier input is not an object');",
    '}',
    "if (typeof parsed.threadId !== 'string' || parsed.threadId.length === 0) {",
    "  throw new Error('courier input threadId is invalid');",
    '}',
    "if (typeof parsed.prompt !== 'string' || parsed.prompt.length === 0) {",
    "  throw new Error('courier input prompt is invalid');",
    '}',
    "if (parsed.hostId !== undefined && typeof parsed.hostId !== 'string') {",
    "  throw new Error('courier input hostId is invalid');",
    '}',
    'for (const key of Object.keys(parsed)) {',
    "  if (key !== 'threadId' && key !== 'prompt' && key !== 'hostId') {",
    "    throw new Error('courier input has an unexpected key');",
    '  }',
    '}',
    `await tools.${SEND_COMMAND}(parsed);`
  ].join('\n');
}

export function courierProgramInstructions(argv: readonly string[]): string {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('courier input reader argv is missing');
  for (const value of argv) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('courier input reader argv is invalid');
  }
  return [INSTRUCTION, '', '```javascript', programBody(argv), '```'].join('\n');
}
