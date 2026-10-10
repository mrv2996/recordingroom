import { drills } from './drills.ts';

export const MAX_CUSTOM_PROMPT_LENGTH = 8000;
export const MAX_SESSION_REQUEST_BYTES = 64 * 1024;
export type SessionRequest = { drillId: string; mode: 'thinking' | 'conversation'; customPrompt?: string };

export function validateSessionRequest(value: unknown): SessionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a practice problem and turn-taking mode.');
  const input = value as Record<string, unknown>;
  if (!drills.some(d => d.id === input.drillId) || typeof input.mode !== 'string' || !['thinking', 'conversation'].includes(input.mode)) throw new Error('Choose a practice problem and turn-taking mode.');
  if (input.customPrompt !== undefined && (typeof input.customPrompt !== 'string' || input.customPrompt.length > MAX_CUSTOM_PROMPT_LENGTH)) throw new Error(`Keep your custom prompt under ${MAX_CUSTOM_PROMPT_LENGTH.toLocaleString('en-GB')} characters.`);
  return { drillId: input.drillId as string, mode: input.mode as SessionRequest['mode'], customPrompt: (input.customPrompt as string | undefined)?.trim() || undefined };
}
