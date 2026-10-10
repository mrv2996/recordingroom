import { FINISH_CASE_MESSAGE } from './coaching-policy.ts';
import { isQuotaError, microphoneError, type RealtimeEvent } from './realtime-events.ts';
import { readSessionResponse } from './session-response.ts';

export type VoiceState = {
  connection: 'idle' | 'permission' | 'connecting' | 'connected' | 'recovering' | 'ended' | 'error';
  mic: boolean; turnOpen: boolean; userSpeaking: boolean; generating: boolean; speaking: boolean;
  soundBlocked: boolean; level: number; error: string; notice: string;
  casePhase: 'practice' | 'finishing' | 'feedback'; userTurns: number;
};
export const initialVoiceState: VoiceState = { connection: 'idle', mic: false, turnOpen: false, userSpeaking: false, generating: false, speaking: false, soundBlocked: false, level: 0, error: '', notice: '', casePhase: 'practice', userTurns: 0 };
type Options = {
  drillId: string; mode: 'thinking' | 'conversation'; customPrompt?: string; audio: HTMLAudioElement;
  onState: (state: VoiceState) => void; onEvent: (event: RealtimeEvent) => void; onInterrupt: () => void;
};

export class RealtimeVoice {
  private state = { ...initialVoiceState };
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stream?: MediaStream;
  private abort = new AbortController();
  private closed = false;
  private pendingCommit = false;
  private turnStarted = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private connectTimer?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private commitTimer?: ReturnType<typeof setTimeout>;
  private responseTimer?: ReturnType<typeof setTimeout>;
  constructor(private options: Options) {}
  private patch(next: Partial<VoiceState>) { this.state = { ...this.state, ...next }; this.options.onState(this.state); }
  private later(fn: () => void, ms: number) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.closed) fn(); }, ms);
    this.timers.add(timer); return timer;
  }
  private send(event: object) {
    if (this.closed || this.channel?.readyState !== 'open') return false;
    this.channel.send(JSON.stringify(event)); return true;
  }
  private setMic(enabled: boolean) {
    this.stream?.getAudioTracks().forEach(track => { track.enabled = enabled; });
    this.patch({ mic: enabled, userSpeaking: false, level: 0 });
  }
  private fail(message: string) { this.dispose(); this.patch({ ...initialVoiceState, connection: 'error', error: message }); }

  async connect() {
    this.patch({ connection: 'permission', error: '', notice: '' });
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      this.fail('Live voice needs a browser with microphone and WebRTC support, on localhost or HTTPS. Try a current desktop Chrome or Edge browser.'); return;
    }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
    catch (error) { if (!this.closed) this.fail(microphoneError(error)); return; }
    // A permission prompt can outlive Cancel or unmount. Release a late stream immediately.
    if (this.closed) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream; this.setMic(false);
    stream.getAudioTracks().forEach(track => {
      track.onended = () => { if (!this.closed) this.fail('Your microphone disconnected. Reconnect it and start a new session.'); };
    });
    this.patch({ connection: 'connecting' });
    this.connectTimer = this.later(() => this.fail('The voice connection timed out. Check your network or VPN, then try again.'), 30_000);
    try {
      const tokenResponse = await fetch('/api/realtime/session', {
        method: 'POST', credentials: 'same-origin', signal: this.abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drillId: this.options.drillId, mode: this.options.mode, customPrompt: this.options.customPrompt?.trim() || undefined }),
      });
      const token = await readSessionResponse<{ value?: string; expires_at?: number }>(tokenResponse);
      if (!token.value || !token.expires_at || token.expires_at * 1000 <= Date.now()) throw new Error('The session credential expired. Please start again.');
      if (this.closed) return;
      const pc = new RTCPeerConnection(); this.pc = pc;
      pc.ontrack = event => {
        this.options.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void this.enableSound();
      };
      pc.onconnectionstatechange = () => {
        if (this.closed) return;
        if (pc.connectionState === 'failed') this.fail('The voice connection was lost. Start a fresh session when your network is back. Your transcript is still below.');
        if (pc.connectionState === 'disconnected') {
          this.patch({ connection: 'recovering', notice: 'Connection interrupted. Trying to reconnect…' });
          clearTimeout(this.recoveryTimer);
          this.recoveryTimer = this.later(() => this.fail('The connection did not recover. Start a new session to continue.'), 8_000);
        }
        if (pc.connectionState === 'connected') {
          clearTimeout(this.recoveryTimer);
          if (this.channel?.readyState === 'open') this.patch({ connection: 'connected', notice: '' });
        }
      };
      stream.getAudioTracks().forEach(track => pc.addTrack(track, stream));
      const channel = pc.createDataChannel('oai-events'); this.channel = channel;
      channel.onmessage = event => { if (!this.closed) { try { this.handle(JSON.parse(event.data)); } catch { /* Ignore unknown/non-JSON events. */ } } };
      channel.onerror = () => { if (!this.closed) this.fail('The voice control connection failed. Please start a new session.'); };
      channel.onclose = () => { if (!this.closed) this.fail('The voice session closed. Your transcript is still below; start again for a fresh session.'); };
      channel.onopen = () => {
        if (this.closed) return;
        clearTimeout(this.connectTimer);
        this.patch({ connection: 'connected', notice: '' });
        this.requestResponse();
        if (this.options.mode === 'conversation') this.setMic(true);
        this.later(() => this.patch({ notice: 'Five minutes left in this session. Finish your drill, then start a new session.' }), 50 * 60_000);
        this.later(() => this.end('Session finished after 55 minutes. Start a fresh session whenever you are ready.'), 55 * 60_000);
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST', body: offer.sdp, signal: this.abort.signal,
        headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
      });
      if (!answer.ok) {
        const failure = await answer.json().catch(() => ({})) as { error?: { code?: string } };
        throw new Error(isQuotaError(failure.error?.code) ? 'This OpenAI API project has no available credits. Check API billing and credit balance, then start again.' : answer.status === 401 ? 'The short-lived session credential expired. Start again for a fresh connection.' : answer.status === 429 ? 'OpenAI cannot open another voice connection right now. Check API quota or wait a minute and retry.' : 'OpenAI could not open the audio connection. Check the configured model and network, then retry.');
      }
      const sdp = await answer.text();
      if (!this.closed) await pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (error) {
      if (!this.closed) this.fail(error instanceof TypeError ? 'The audio connection could not reach the server. Check your connection and retry.' : error instanceof Error ? error.message : 'The voice connection failed. Please try again.');
    }
  }

  private requestResponse() {
    if (this.send({ type: 'response.create' })) {
      this.patch({ generating: true, error: '' });
      clearTimeout(this.responseTimer);
      this.responseTimer = this.later(() => this.fail('The coach did not respond in time. Your transcript is preserved; start a new session to try again.'), 45_000);
    }
  }

  private handle(event: RealtimeEvent) {
    this.options.onEvent(event);
    switch (event.type) {
      case 'input_audio_buffer.committed':
        this.patch({ userTurns: this.state.userTurns + 1 });
        if (this.pendingCommit) { this.pendingCommit = false; clearTimeout(this.commitTimer); this.requestResponse(); }
        break;
      case 'input_audio_buffer.speech_started':
        this.patch({ userSpeaking: true });
        if (this.state.speaking || this.state.generating) this.options.onInterrupt();
        break;
      case 'input_audio_buffer.speech_stopped': this.patch({ userSpeaking: false }); break;
      case 'response.created':
        this.patch({ generating: true });
        clearTimeout(this.responseTimer);
        this.responseTimer = this.later(() => this.fail('The coach did not respond in time. Your transcript is preserved; start a new session to try again.'), 45_000);
        break;
      case 'output_audio_buffer.started': clearTimeout(this.responseTimer); this.patch({ speaking: true }); break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared': this.patch({ speaking: false }); break;
      case 'response.done': {
        clearTimeout(this.responseTimer); this.patch({ generating: false });
        if (this.state.casePhase === 'finishing' && event.response?.status === 'completed') this.patch({ casePhase: 'feedback', notice: 'Your feedback is in the transcript. Continue practising or end the session when ready.' });
        if (event.response?.status === 'failed') {
          const quota = isQuotaError(event.response.status_details?.error?.code);
          this.fail(quota ? 'This OpenAI API project has no available credits. Check API billing and credit balance, then start again.' : 'The coach could not finish its response. Please start a new session.');
        }
        break;
      }
      case 'error': {
        const code = event.error?.code;
        if (code === 'response_cancel_not_active') break;
        if (code === 'input_audio_buffer_commit_empty') {
          this.pendingCommit = false; clearTimeout(this.commitTimer);
          this.patch({ generating: false, error: 'No audio reached the coach. Check your input device, then start your answer again.' }); break;
        }
        this.fail(isQuotaError(code) ? 'This OpenAI API project has no available credits. Check API billing and credit balance, then start again.' : 'The voice service reported a problem. Start a new session to recover.');
        break;
      }
    }
  }

  startAnswer() {
    if (this.state.connection !== 'connected' || this.pendingCommit || this.state.casePhase === 'finishing') return;
    this.interrupt();
    if (this.state.casePhase === 'feedback') {
      this.send({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: this.options.mode === 'thinking' ? null : { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true } } } } });
      this.patch({ casePhase: 'practice', notice: '' });
    }
    this.send({ type: 'input_audio_buffer.clear' });
    this.turnStarted = Date.now(); this.patch({ turnOpen: true, error: '' }); this.setMic(true);
  }
  finishAnswer() {
    if (this.options.mode !== 'thinking' || !this.state.turnOpen || this.pendingCommit || this.state.connection !== 'connected') return;
    if (Date.now() - this.turnStarted < 600) { this.patch({ error: 'Say a little more before handing the turn to your coach.' }); return; }
    this.setMic(false); this.patch({ turnOpen: false, generating: true, error: '' });
    this.pendingCommit = true;
    // Allow the last RTP audio packets to arrive before committing on the separate data channel.
    this.later(() => {
      if (!this.pendingCommit) return;
      this.send({ type: 'input_audio_buffer.commit' });
      this.commitTimer = this.later(() => this.fail('Your audio turn was not acknowledged. Start a fresh session to recover.'), 8_000);
    }, 200);
  }
  toggleMic() {
    if (this.state.connection !== 'connected' || this.pendingCommit || this.state.casePhase === 'finishing') return;
    if (!this.state.mic && !this.state.turnOpen) { this.startAnswer(); return; }
    const enable = !this.state.mic;
    if (this.options.mode === 'conversation' && !enable) this.send({ type: 'input_audio_buffer.clear' });
    this.setMic(enable);
  }
  interrupt() {
    if (this.state.casePhase === 'finishing') this.patch({ casePhase: 'feedback', notice: 'Feedback stopped. Continue practising or request feedback again when ready.' });
    if (this.pendingCommit) { this.pendingCommit = false; clearTimeout(this.commitTimer); this.send({ type: 'input_audio_buffer.clear' }); }
    if (this.state.generating) this.send({ type: 'response.cancel' });
    if (this.state.speaking || this.state.generating) {
      this.send({ type: 'output_audio_buffer.clear' });
      this.options.onInterrupt();
    }
    clearTimeout(this.responseTimer);
    this.patch({ speaking: false, generating: false });
  }
  finishCase() {
    if (this.state.connection !== 'connected' || !this.state.userTurns || this.pendingCommit || this.state.generating || this.state.speaking || this.state.userSpeaking || (this.options.mode === 'thinking' && this.state.turnOpen)) return;
    this.setMic(false);
    this.patch({ casePhase: 'finishing', turnOpen: false, notice: 'Preparing your case feedback…', error: '' });
    // Stop automatic turns while reviewing; keep the same conversation and its evidence.
    this.send({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: null } } } });
    this.send({ type: 'input_audio_buffer.clear' });
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: FINISH_CASE_MESSAGE }] } });
    this.requestResponse();
  }
  async enableSound() {
    try { await this.options.audio.play(); if (!this.closed) this.patch({ soundBlocked: false }); }
    catch { if (!this.closed) this.patch({ soundBlocked: true }); }
  }
  end(notice = 'Session ended. Your microphone is off.') {
    this.dispose(); this.patch({ ...initialVoiceState, connection: 'ended', notice });
  }
  dispose() {
    if (this.closed) return;
    this.closed = true; this.abort.abort();
    this.timers.forEach(clearTimeout); this.timers.clear();
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    if (this.channel) { this.channel.onclose = null; this.channel.onerror = null; this.channel.onmessage = null; this.channel.onopen = null; this.channel.close(); }
    if (this.pc) { this.pc.ontrack = null; this.pc.onconnectionstatechange = null; this.pc.close(); }
    this.options.audio.pause(); this.options.audio.srcObject = null;
  }
}
