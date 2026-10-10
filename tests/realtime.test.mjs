import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeVoice } from '../lib/realtime-client.ts';
import { updateCaptions, isQuotaError, microphoneError } from '../lib/realtime-events.ts';
import { realtimeSession, upstreamFailure } from '../lib/realtime-config.ts';
import { readSessionResponse } from '../lib/session-response.ts';
import { validateSessionRequest, MAX_CUSTOM_PROMPT_LENGTH } from '../lib/session-request.ts';

test('late input captions keep the learner before the coach and final captions replace deltas', () => {
  let rows = updateCaptions([], { type: 'input_audio_buffer.committed', item_id: 'user-1' });
  rows = updateCaptions(rows, { type: 'response.output_audio_transcript.delta', item_id: 'coach-1', delta: 'What outcome?' });
  rows = updateCaptions(rows, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: 'I would clarify success.' });
  rows = updateCaptions(rows, { type: 'response.output_audio_transcript.done', item_id: 'coach-1', transcript: 'What outcome matters?' });
  assert.deepEqual(rows.map(r => r.role), ['user', 'assistant']);
  assert.equal(rows[1].text, 'What outcome matters?');
  assert.equal(rows[0].final, true);
});
test('late item-added event cannot erase captions', () => {
  let rows = updateCaptions([], { type: 'response.output_audio_transcript.delta', item_id: 'a', delta: 'Hello' });
  rows = updateCaptions(rows, { type: 'conversation.item.added', item: { id: 'a', type: 'message', role: 'assistant', content: [] } });
  assert.equal(rows[0].text, 'Hello');
});
test('billing exhaustion is different from rate limiting, including the observed account error', () => {
  assert.equal(isQuotaError('credit_balance_exhausted'), true);
  assert.equal(upstreamFailure(429, 'credit_balance_exhausted').code, 'quota');
  assert.equal(upstreamFailure(429, 'rate_limit_exceeded').code, 'rate_limit');
  assert.match(microphoneError(new DOMException('', 'NotAllowedError')), /blocked/);
});
test('thinking mode never automatically answers and conversation mode allows interruption', () => {
  assert.equal(realtimeSession('ai', 'thinking').audio.input.turn_detection, null);
  const auto = realtimeSession('all-hands', 'conversation');
  assert.equal(auto.audio.input.turn_detection.interrupt_response, true);
  assert.equal(auto.audio.input.turn_detection.eagerness, 'low');
  assert.match(auto.instructions, /all-hands/);
});

function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000 });
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; }, onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = { readyState: 'open', sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 'closed'; } };
  const peer = { connectionState: 'new', addTrack() {}, createDataChannel: () => channel, createOffer: async () => ({ sdp: 'synthetic-offer' }), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() { this.connectionState = 'closed'; } };
  const originals = new Map(['window', 'navigator', 'RTCPeerConnection', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: true, RTCPeerConnection: true } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: options.media || (async () => stream) } } });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: class { constructor() { return peer; } } });
  const requests = [];
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (url, init) => {
    requests.push({ url, init });
    return url.startsWith('/api') ? options.tokenResponse || Response.json(options.tokenFailure || { value: 'ephemeral-test-only', expires_at: 1000 }, { status: options.tokenFailure ? 502 : 200 }) : new Response('synthetic-answer');
  } });
  let state;
  const audio = { srcObject: null, play: options.play || (async () => {}), pause() {} };
  const client = new RealtimeVoice({ drillId: 'ai', mode: options.mode || 'thinking', customPrompt: options.customPrompt, audio, onState: s => { state = s; }, onEvent() {}, onInterrupt() {} });
  t.after(() => { client.dispose(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { client, track, stream, channel, peer, audio, requests, state: () => state, event: event => channel.onmessage({ data: JSON.stringify(event) }), open: () => channel.onopen() };
}
test('microphone stays muted on connect, manual turn waits for committed acknowledgement', async t => {
  const h = harness(t); await h.client.connect(); h.open();
  assert.equal(h.track.enabled, false);
  h.event({ type: 'response.done', response: { status: 'completed' } });
  h.channel.sent.length = 0;
  h.client.startAnswer(); assert.equal(h.track.enabled, true);
  t.mock.timers.tick(1000); h.client.finishAnswer();
  assert.equal(h.track.enabled, false);
  t.mock.timers.tick(200);
  assert.deepEqual(h.channel.sent.map(e => e.type), ['input_audio_buffer.clear', 'input_audio_buffer.commit']);
  h.event({ type: 'input_audio_buffer.committed', item_id: 'u' });
  assert.equal(h.channel.sent.at(-1).type, 'response.create');
  h.client.end(); assert.equal(h.track.stopped, true); assert.equal(h.peer.connectionState, 'closed');
});
test('cancel during a microphone prompt releases a stream granted later', async t => {
  let grant; const h = harness(t, { media: () => new Promise(resolve => { grant = resolve; }) });
  const pending = h.client.connect(); h.client.end(); grant(h.stream); await pending;
  assert.equal(h.track.stopped, true); assert.equal(h.state().connection, 'ended');
});
test('server token failure releases microphone and surfaces safe error', async t => {
  const h = harness(t, { tokenFailure: { error: 'Check API billing.' } }); await h.client.connect();
  assert.equal(h.track.stopped, true); assert.equal(h.state().connection, 'error'); assert.equal(h.state().error, 'Check API billing.');
});
test('temporary network loss recovers; persistent loss closes all audio', async t => {
  const h = harness(t); await h.client.connect(); h.open();
  h.peer.connectionState = 'disconnected'; h.peer.onconnectionstatechange();
  assert.equal(h.state().connection, 'recovering');
  t.mock.timers.tick(2000); h.peer.connectionState = 'connected'; h.peer.onconnectionstatechange();
  assert.equal(h.state().connection, 'connected');
  h.peer.connectionState = 'disconnected'; h.peer.onconnectionstatechange(); t.mock.timers.tick(8000);
  assert.equal(h.state().connection, 'error'); assert.equal(h.track.stopped, true);
});
test('credit exhaustion during a live session is actionable and releases microphone', async t => {
  const h = harness(t); await h.client.connect(); h.open();
  h.event({ type: 'error', error: { code: 'credit_balance_exhausted' } });
  assert.match(h.state().error, /credit balance/); assert.equal(h.track.stopped, true);
});
test('autoplay block can recover with enable sound', async t => {
  let blocked = true;
  const h = harness(t, { play: async () => { if (blocked) throw new Error('autoplay'); } }); await h.client.connect(); h.open();
  await h.client.enableSound(); assert.equal(h.state().soundBlocked, true);
  blocked = false; await h.client.enableSound(); assert.equal(h.state().soundBlocked, false);
});
test('manual pause retains the turn and stopping a pending response prevents a delayed commit', async t => {
  const h = harness(t); await h.client.connect(); h.open(); h.client.startAnswer();
  h.client.toggleMic(); assert.equal(h.track.enabled, false); assert.equal(h.state().turnOpen, true);
  h.client.toggleMic(); assert.equal(h.track.enabled, true);
  t.mock.timers.tick(1000); h.client.finishAnswer(); h.client.interrupt(); t.mock.timers.tick(300);
  assert.equal(h.channel.sent.some(e => e.type === 'input_audio_buffer.commit'), false);
});
test('natural conversation opens the mic and finishing a case requests feedback in the existing session', async t => {
  const h = harness(t, { mode: 'conversation' }); await h.client.connect(); h.open();
  assert.equal(h.track.enabled, true);
  h.event({ type: 'response.done', response: { status: 'completed' } });
  h.event({ type: 'input_audio_buffer.committed', item_id: 'answer' });
  h.channel.sent.length = 0; h.client.finishCase();
  assert.equal(h.track.enabled, false);
  assert.equal(h.state().casePhase, 'finishing');
  assert.deepEqual(h.channel.sent.map(e => e.type), ['session.update', 'input_audio_buffer.clear', 'conversation.item.create', 'response.create']);
  assert.equal(h.channel.sent[0].session.audio.input.turn_detection, null);
  assert.match(h.channel.sent[2].item.content[0].text, /final feedback/);
  assert.notEqual(h.peer.connectionState, 'closed');
  h.event({ type: 'response.done', response: { status: 'completed' } });
  assert.equal(h.state().casePhase, 'feedback');
  h.client.toggleMic();
  assert.equal(h.state().casePhase, 'practice'); assert.equal(h.track.enabled, true);
  assert.equal(h.channel.sent.findLast(e => e.type === 'session.update').session.audio.input.turn_detection.type, 'semantic_vad');
});
test('finish case cannot cut off speech, a coach response or an unfinished manual answer', async t => {
  const h = harness(t); await h.client.connect(); h.open();
  h.event({ type: 'input_audio_buffer.committed', item_id: 'answer' });
  h.channel.sent.length = 0;
  h.client.finishCase(); assert.equal(h.channel.sent.length, 0);
  h.event({ type: 'response.done', response: { status: 'completed' } });
  h.event({ type: 'input_audio_buffer.speech_started' });
  h.client.finishCase(); assert.equal(h.channel.sent.length, 0);
  h.event({ type: 'input_audio_buffer.speech_stopped' });
  h.client.startAnswer(); h.channel.sent.length = 0;
  h.client.finishCase(); assert.equal(h.channel.sent.length, 0);
});
test('stopping feedback allows a retry without leaving the session stuck', async t => {
  const h = harness(t, { mode: 'conversation' }); await h.client.connect(); h.open();
  h.event({ type: 'response.done', response: { status: 'completed' } });
  h.event({ type: 'input_audio_buffer.committed', item_id: 'answer' });
  h.client.finishCase(); h.client.interrupt();
  assert.equal(h.state().casePhase, 'feedback'); assert.equal(h.state().generating, false);
  h.client.toggleMic(); assert.equal(h.track.enabled, true); assert.equal(h.state().casePhase, 'practice');
});


test('HTML server failures become safe actionable errors instead of JSON parse errors', async () => {
  for (const status of [200, 500, 502]) {
    await assert.rejects(readSessionResponse(new Response('<!DOCTYPE html><p>internal detail</p>', { status })), error => {
      assert.match(error.message, /Reopen the coach/);
      assert.match(error.message, new RegExp('HTTP ' + status));
      assert.doesNotMatch(error.message, /internal detail|Unexpected token/);
      return true;
    });
  }
  await assert.rejects(readSessionResponse(Response.json({ error: 'Check API billing.' }, { status: 502 })), /Check API billing/);
  await assert.rejects(readSessionResponse(Response.json(null)), /invalid response/);
  await assert.rejects(readSessionResponse(new Response('<html>sign in</html>', { status: 401 })), /sign-in expired/);
  assert.deepEqual(await readSessionResponse(Response.json({ configured: true })), { configured: true });
});

test('HTML token failure closes microphone and never starts a peer connection', async t => {
  const h = harness(t, { tokenResponse: new Response('<!DOCTYPE html>', { status: 500 }) });
  await h.client.connect();
  assert.equal(h.track.stopped, true);
  assert.equal(h.state().connection, 'error');
  assert.match(h.state().error, /HTTP 500/);
  assert.equal(h.requests.length, 1);
});

test('custom prompt is sent with the session request before the coach responds', async t => {
  const h = harness(t, { customPrompt: '  Ask me to diagnose Emma paid conversion.  ' });
  await h.client.connect();
  assert.equal(JSON.parse(h.requests[0].init.body).customPrompt, 'Ask me to diagnose Emma paid conversion.');
  assert.equal(h.channel.sent.length, 0);
});

test('session request accepts full custom prompts and rejects malformed or excessive input', () => {
  assert.equal(validateSessionRequest({ drillId: 'open', mode: 'conversation', customPrompt: ' x ' }).customPrompt, 'x');
  assert.equal(validateSessionRequest({ drillId: 'diagnostic', mode: 'thinking', customPrompt: '  ' }).customPrompt, undefined);
  assert.equal(validateSessionRequest({ drillId: 'open', mode: 'conversation', customPrompt: 'x'.repeat(MAX_CUSTOM_PROMPT_LENGTH) }).customPrompt.length, MAX_CUSTOM_PROMPT_LENGTH);
  for (const input of [null, [], { drillId: 'bad', mode: 'thinking' }, { drillId: 'open', mode: ['conversation'] }, { drillId: 'open', mode: 'conversation', customPrompt: {} }, { drillId: 'open', mode: 'conversation', customPrompt: 'x'.repeat(MAX_CUSTOM_PROMPT_LENGTH + 1) }]) {
    assert.throws(() => validateSessionRequest(input));
  }
});

test('custom case replaces preset brief while keeping critical coaching and realtime audio', () => {
  const prompt = 'Emma conversion fell from 6% to 4%. Ask me how I would investigate.';
  const config = realtimeSession('diagnostic', 'conversation', undefined, prompt);
  assert.ok(config.instructions.includes(prompt));
  assert.match(config.instructions, /Start with its question or brief/);
  assert.match(config.instructions, /Challenge vague claims/);
  assert.doesNotMatch(config.instructions, /sales cycle has increased 30%/);
  assert.deepEqual(config.output_modalities, ['audio']);
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
  assert.match(realtimeSession('diagnostic', 'thinking', undefined, '  ').instructions, /sales cycle has increased 30%/);
});
