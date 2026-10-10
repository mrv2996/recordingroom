export type Caption = { id: string; role: 'user' | 'assistant'; text: string; final: boolean; interrupted?: boolean };
export const isQuotaError = (code?: string) => ['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached'].includes(code || '');
export type RealtimeEvent = {
  type: string; item_id?: string; previous_item_id?: string; delta?: string; transcript?: string;
  item?: { id: string; role?: string; type?: string; content?: { type: string; text?: string; transcript?: string }[] };
  response?: { id?: string; status?: string; status_details?: { error?: { code?: string } }; output?: { id: string }[] };
  error?: { code?: string; message?: string };
};

// Items are inserted on conversation events so late input captions cannot reorder the conversation.
export function updateCaptions(rows: Caption[], e: RealtimeEvent): Caption[] {
  let id = e.item_id, role: Caption['role'] | undefined, value: string | undefined, final = false, append = false;
  if ((e.type === 'conversation.item.added' || e.type === 'conversation.item.created') && e.item?.type === 'message') {
    id = e.item.id;
    if (e.item.role !== 'user' && e.item.role !== 'assistant') return rows;
    role = e.item.role;
    value = e.item.content?.map(c => c.transcript || c.text || '').join('') || '';
  } else if (e.type === 'input_audio_buffer.committed') {
    role = 'user'; value = '';
  } else if (e.type.startsWith('conversation.item.input_audio_transcription.')) {
    role = 'user'; final = e.type.endsWith('.completed') || e.type.endsWith('.failed');
    if (e.type.endsWith('.failed')) value = '[Caption unavailable. The coach still received your audio.]';
    else { append = e.type.endsWith('.delta'); value = append ? e.delta : e.transcript; }
  } else if (e.type.startsWith('response.output_audio_transcript.')) {
    role = 'assistant'; final = e.type.endsWith('.done'); append = e.type.endsWith('.delta');
    value = append ? e.delta : e.transcript;
  }
  if (!id || !role || value === undefined) return rows;
  const existing = rows.find(r => r.id === id);
  // A late item-added event must not erase a caption that already streamed.
  const next: Caption = { id, role, text: append ? (existing?.text || '') + value : value || existing?.text || '', final: final || existing?.final || false, interrupted: existing?.interrupted };
  if (existing) return rows.map(r => r.id === id ? next : r);
  const prior = e.previous_item_id ? rows.findIndex(r => r.id === e.previous_item_id) : -1;
  return prior >= 0 ? [...rows.slice(0, prior + 1), next, ...rows.slice(prior + 1)] : [...rows, next];
}

export function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow microphone access for this page in the browser’s site settings, then try again.';
  if (name === 'NotFoundError') return 'No microphone was found. Connect a microphone, then try again.';
  if (name === 'NotReadableError') return 'The microphone is unavailable or in use. Check your input device and other audio apps, then retry.';
  return 'The microphone could not be opened. Check the browser and Windows microphone permissions, then try again.';
}
