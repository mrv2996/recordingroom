// A live API check using synthetic text, never the computer's microphone.
// Prints only safe counts/status. The standard key is read only by the application server.
const origin = 'http://localhost:5173';
const headers = { Origin: origin, Cookie: '__sites_local_auth=1', 'Content-Type': 'application/json' };
const status = await fetch(`${origin}/api/realtime/session`, { headers });
const statusData = await status.json();
console.log(JSON.stringify({ check: 'server', status: status.status, configured: statusData.configured, model: statusData.model }));
const denied = await fetch(`${origin}/api/realtime/session`, { method: 'POST', headers: { ...headers, Origin: 'https://example.invalid' }, body: JSON.stringify({ drillId: 'ai', mode: 'thinking' }) });
console.log(JSON.stringify({ check: 'cross-origin rejected', passed: denied.status === 403 }));
const anonymous = await fetch(`${origin}/api/realtime/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ drillId: 'ai', mode: 'thinking' }) });
console.log(JSON.stringify({ check: 'anonymous rejected', passed: anonymous.status === 401 }));
const response = await fetch(`${origin}/api/realtime/session`, { method: 'POST', headers, body: JSON.stringify({ drillId: 'ai', mode: 'thinking' }), signal: AbortSignal.timeout(30000) });
const token = await response.json();
console.log(JSON.stringify({ check: 'mint', status: response.status, receivedEphemeralToken: Boolean(token.value), ...(token.error ? { error: token.error, code: token.code } : {}) }));
if (!response.ok || !token.value) process.exit(1);
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(statusData.model)}`, ['realtime', `openai-insecure-api-key.${token.value}`]);
  let audioBytes = 0, captionChars = 0, completed = false;
  const timeout = setTimeout(() => { ws.close(); reject(new Error('Voice response timed out')); }, 30000);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Briefly welcome me to this practice session in one sentence.' }] } }));
    ws.send(JSON.stringify({ type: 'response.create' }));
  });
  ws.addEventListener('message', message => {
    const event = JSON.parse(message.data);
    if (event.type === 'response.output_audio.delta') audioBytes += Buffer.from(event.delta, 'base64').length;
    if (event.type === 'response.output_audio_transcript.delta') captionChars += event.delta?.length || 0;
    if (event.type === 'error') { clearTimeout(timeout); ws.close(); reject(new Error(`Realtime API error: ${event.error?.code || 'unknown'}`)); }
    if (event.type === 'response.done') {
      completed = true; clearTimeout(timeout);
      console.log(JSON.stringify({ check: 'live audio response', status: event.response?.status, audioBytes, captionChars, errorCode: event.response?.status_details?.error?.code }));
      ws.close();
      if (event.response?.status === 'completed' && audioBytes > 0 && captionChars > 0) resolve();
      else reject(new Error('Live audio did not complete'));
    }
  });
  ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket transport failed')); });
  ws.addEventListener('close', () => { if (!completed) { clearTimeout(timeout); reject(new Error('WebSocket closed before audio completed')); } });
}).catch(error => { console.error(error.message); process.exitCode = 1; });
