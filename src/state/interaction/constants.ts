export const INTERACTION_ORIGIN = 'interaction-origin' as const;
export const INTERACTION_TRANSPORT = 'interaction-callback' as const;
export const INTERACTION_SOURCES = Object.freeze({
  SLASH_COMMAND: 'slash-command',
  DECISION_COMPONENT: 'decision-component'
} as const);
