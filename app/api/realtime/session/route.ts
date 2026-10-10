import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { DEFAULT_REALTIME_MODEL, realtimeSession, upstreamFailure } from '@/lib/realtime-config';
import { MAX_SESSION_REQUEST_BYTES, validateSessionRequest, type SessionRequest } from '@/lib/session-request';

export const dynamic = 'force-dynamic';
const settings = () => env as unknown as { OPENAI_API_KEY?: string; OPENAI_REALTIME_MODEL?: string };
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache', 'Vary': 'Cookie' },
});
// A local/per-worker guard. Use a shared rate limiter before scaling to multiple workers.
const attempts = new Map<string, number[]>();

export async function GET() {
  if (!await getChatGPTUser()) return json({ error: 'Sign in to connect your coach.', code: 'sign_in' }, 401);
  return json({ configured: Boolean(settings().OPENAI_API_KEY?.trim()), model: settings().OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Your sign-in expired. Reload the app to sign in again.', code: 'sign_in' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Start this session from the app.', code: 'origin' }, 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Expected a session request.', code: 'input' }, 415);
  if (Number(request.headers.get('content-length') || 0) > MAX_SESSION_REQUEST_BYTES) return json({ error: 'Session request is too large.', code: 'input' }, 413);
  let input: SessionRequest;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_SESSION_REQUEST_BYTES) return json({ error: 'Session request is too large.', code: 'input' }, 413);
    input = validateSessionRequest(JSON.parse(raw));
  } catch (error) { return json({ error: error instanceof SyntaxError ? 'Send a valid session request.' : error instanceof Error ? error.message : 'Choose a practice problem and turn-taking mode.', code: 'input' }, 400); }
  const key = settings().OPENAI_API_KEY?.trim();
  if (!key) return json({ error: 'Add OPENAI_API_KEY to the server’s .env file and restart the app.', code: 'missing_key' }, 503);
  const now = Date.now();
  for (const [id, times] of attempts) if (!times.some(t => now - t < 60_000)) attempts.delete(id);
  const times = (attempts.get(user.userId) || []).filter(t => now - t < 60_000);
  if (times.length >= 5) return json({ error: 'You have started several sessions quickly. Wait one minute and try again.', code: 'rate_limit' }, 429);
  attempts.set(user.userId, [...times, now]);
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.userId));
    const safetyId = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'OpenAI-Safety-Identifier': safetyId },
      body: JSON.stringify({ session: realtimeSession(input.drillId, input.mode, settings().OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL, input.customPrompt) }),
    });
    const data = await response.json() as { value?: string; expires_at?: number; error?: { code?: string } };
    if (!response.ok) return json(upstreamFailure(response.status, data.error?.code), 502);
    if (!data.value || !data.expires_at) throw new Error('Invalid token response');
    // Return only the short-lived client credential. Never echo the permanent key or upstream request.
    return json({ value: data.value, expires_at: data.expires_at });
  } catch { return json({ error: 'The server could not reach OpenAI in time. Check its network connection, then try again.', code: 'network' }, 502); }
}
