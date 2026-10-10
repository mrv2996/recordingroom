import { coachingPolicy } from './coaching-policy.ts';
import { drills } from './drills.ts';
import { isQuotaError } from './realtime-events.ts';

export type TurnMode = 'thinking' | 'conversation';
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1';

export function realtimeSession(drillId: string, mode: TurnMode, model = DEFAULT_REALTIME_MODEL, customPrompt?: string) {
  const drill = drills.find(d => d.id === drillId)!;
  const prompt = customPrompt?.trim();
  const instructions = prompt
    ? `${coachingPolicy('Custom case practice', 'Use the learner-supplied custom case prompt below as the starting brief and practice request.', 'general')}\n\n# Custom case practice\nThe following learner-supplied prompt replaces the preset starting scenario. Honour its interview topic, case facts and requested opening question, while keeping the coaching standards above. Start with its question or brief; do not ask the learner to select a topic again. Do not reveal a solution or invent missing company data.\n<learner_case_prompt>\n${prompt}\n</learner_case_prompt>`
    : coachingPolicy(drill.question, drill.context, drill.id === 'diagnostic' ? 'diagnostic' : 'general');
  return {
    type: 'realtime', model, output_modalities: ['audio'], max_output_tokens: 1000,
    instructions,
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
        turn_detection: mode === 'thinking' ? null : {
          type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true,
        },
      },
      output: { voice: 'marin' },
    },
  };
}

export function upstreamFailure(status: number, code?: string) {
  if (status === 401) return { code: 'invalid_key', error: 'OpenAI rejected the API key. Update OPENAI_API_KEY in the server configuration, then restart the app.' };
  if (isQuotaError(code)) return { code: 'quota', error: 'This OpenAI API project has no available credits. Check its API billing, credit balance and spending limit, then start again.' };
  if (status === 429) return { code: 'rate_limit', error: 'OpenAI is limiting new sessions. Wait a minute, then try again.' };
  if (status === 403 || code === 'model_not_found') return { code: 'model_access', error: 'This API project cannot access the configured voice model. Check its model access and key permissions.' };
  return { code: 'upstream', error: 'OpenAI could not start the voice session. Please try again shortly. If this continues, check the server model configuration.' };
}
