import {
  CODEX_VALIDATION_KINDS,
  type CodexSessionIdentity,
  type ValidationOptions,
  validateCodexSessionIdentity,
  validateCodexSessionIdentityAsync
} from '../src/native-transcript';

const identity: CodexSessionIdentity = {
  file: '/tmp/session.jsonl',
  sessionId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  threadId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  workspace: '/tmp/workspace'
};

const options: ValidationOptions = { deadline: Date.now() + 1000 };
const kind: typeof CODEX_VALIDATION_KINDS[keyof typeof CODEX_VALIDATION_KINDS] = CODEX_VALIDATION_KINDS.DEADLINE;

validateCodexSessionIdentity(identity.sessionId, '/tmp/workspace', '/tmp/sessions');
void validateCodexSessionIdentityAsync(identity.sessionId, '/tmp/workspace', '/tmp/sessions', options);
void kind;
