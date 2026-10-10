'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Mic, MicOff, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { drills } from '@/lib/drills';
import { RealtimeVoice, initialVoiceState, type VoiceState } from '@/lib/realtime-client';
import { updateCaptions, type Caption } from '@/lib/realtime-events';
import { MAX_CUSTOM_PROMPT_LENGTH } from '@/lib/session-request';
import { readSessionResponse } from '@/lib/session-response';

const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function VoiceCoach() {
  const [drillId, setDrillId] = useState('open');
  const [mode, setMode] = useState<'thinking' | 'conversation'>('conversation');
  const [customPrompt, setCustomPrompt] = useState('');
  const [sessionPrompt, setSessionPrompt] = useState('');
  const [voice, setVoice] = useState<VoiceState>(initialVoiceState);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [setupError, setSetupError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [checked, setChecked] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const session = useRef<RealtimeVoice | null>(null);
  const live = useRef(true);
  const sessionStart = useRef<number | null>(null);
  const drill = drills.find(d => d.id === drillId)!;
  const active = ['permission', 'connecting', 'connected', 'recovering'].includes(voice.connection);
  const connected = voice.connection === 'connected';
  const busy = ['permission', 'connecting'].includes(voice.connection);

  function checkSetup() {
    setChecked(false);
    return fetch('/api/realtime/session', { cache: 'no-store', signal: AbortSignal.timeout(15_000) }).then(async response => {
      const result = await readSessionResponse<{ configured?: boolean }>(response);
      if (typeof result.configured !== 'boolean') throw new Error('The coach server returned an invalid setup response. Refresh and try again.');
      if (live.current) { setConfigured(result.configured === true); setSetupError(''); }
    }).catch(error => { if (live.current) { setConfigured(null); setSetupError(error instanceof Error ? error.message : 'The server is unavailable.'); } })
      .finally(() => { if (live.current) setChecked(true); });
  }
  useEffect(() => {
    live.current = true; void checkSetup();
    return () => { live.current = false; session.current?.dispose(); };
  }, []);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (sessionStart.current) setSeconds(Math.floor((Date.now() - sessionStart.current) / 1000)); }, 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (followTranscript.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [captions]);

  function start() {
    if (active || !audio.current) return;
    session.current?.dispose(); setSeconds(0); sessionStart.current = null;
    setSessionPrompt(customPrompt.trim());
    const next = new RealtimeVoice({
      drillId, mode, customPrompt, audio: audio.current,
      onState: state => { if (live.current) { if (state.connection === 'connected' && !sessionStart.current) sessionStart.current = Date.now(); setVoice(state); } },
      onEvent: event => { if (live.current) setCaptions(rows => updateCaptions(rows, event)); },
      onInterrupt: () => { if (live.current) setCaptions(rows => { const last = rows.findLast(r => r.role === 'assistant'); return rows.map(r => r === last ? { ...r, interrupted: true, final: true } : r); }); },
    });
    session.current = next; void next.connect();
  }
  function downloadTranscript() {
    const content = `Reasoning Room · ${sessionPrompt ? 'Custom case practice' : drill.title}\n${sessionPrompt ? `Case prompt\n${sessionPrompt}\n\n` : ''}AI-generated captions may contain errors. Interrupted coach captions may include unplayed words.\n\n${captions.map(c => `${c.role === 'user' ? 'You' : 'Coach'}${c.interrupted ? ' (interrupted)' : ''}\n${c.text || '[Caption unavailable]'}`).join('\n\n')}`;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'reasoning-room-transcript.txt'; link.click(); URL.revokeObjectURL(url);
  }
  const status = voice.connection === 'permission' ? 'Waiting for microphone permission' : voice.connection === 'connecting' ? 'Connecting…' : voice.connection === 'recovering' ? 'Reconnecting…' : voice.speaking ? 'Coach speaking' : voice.generating ? 'Coach thinking' : voice.mic ? 'Listening — microphone live' : connected ? 'Connected — microphone muted' : 'Microphone off';
  return <main className="coach-app">
    <header><h1>Consulting voice coach</h1><p>Ask sharp questions, test root causes, then recommend. Expect 2–3 critical follow-ups.</p><p className="muted">AI coach with an MBB-style approach. No firm affiliation.</p></header>
    {(configured === false || setupError) && <div className="notice" role="alert"><p>{setupError || 'Add OPENAI_API_KEY to the server’s .env file and restart the app.'}</p><Button variant="outline" onClick={checkSetup} disabled={!checked}>Check connection</Button></div>}
    <div className="settings">
      <div><label htmlFor="drill">Practice</label><Select value={drillId} onValueChange={id => { setDrillId(id); setCaptions([]); setVoice(initialVoiceState); setSeconds(0); }} disabled={active}><SelectTrigger id="drill"><SelectValue/></SelectTrigger><SelectContent>{drills.map(d => <SelectItem key={d.id} value={d.id}>{d.title}</SelectItem>)}</SelectContent></Select></div>
      <div><label htmlFor="turn-mode">Turn-taking</label><Select value={mode} onValueChange={value => setMode(value as typeof mode)} disabled={active}><SelectTrigger id="turn-mode"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="conversation">Natural conversation</SelectItem><SelectItem value="thinking">Thinking space</SelectItem></SelectContent></Select></div>
    </div>
    <section className="custom-prompt" aria-label="Custom case prompt">
      <label htmlFor="custom-prompt">Custom case prompt <span className="muted">(optional)</span></label>
      <Textarea id="custom-prompt" rows={5} value={customPrompt} onChange={event => setCustomPrompt(event.target.value)} maxLength={MAX_CUSTOM_PROMPT_LENGTH} disabled={active} aria-describedby="custom-prompt-help" placeholder="Paste an interview question, case facts, and how you want the coach to challenge you…"/>
      <div className="prompt-footer"><p id="custom-prompt-help" className="muted">Replaces the selected starting case. Sent to OpenAI when you start a voice session.</p><span className="muted">{customPrompt.length.toLocaleString()} / {MAX_CUSTOM_PROMPT_LENGTH.toLocaleString()}</span></div>
      {customPrompt && <Button variant="ghost" disabled={active} onClick={() => setCustomPrompt('')}>Clear prompt</Button>}
    </section>
    {!customPrompt.trim() && drillId !== 'open' && <section className="scenario"><h2>{drill.question}</h2><p>{drill.context}</p><p className="muted">{drillId === 'diagnostic' ? 'Short fictional drills. Recommendations are optional after diagnosis; full case practice remains available.' : 'Fictional scenario. Clarify or state your assumptions.'}</p></section>}
    <section className="voice-session" aria-label="Live voice session">
      <div className="session-heading"><h2 role="status">{voice.mic ? <Mic size={20}/> : <MicOff size={20}/>} {status}</h2><span>{formatTime(seconds)}</span></div>
      <p>{mode === 'thinking' ? 'Take your time. Press “Your turn” when you want the coach to respond.' : 'Starting opens your microphone. Talk naturally; the coach responds when you finish, and you can interrupt.'}</p>
      <div className="controls">
        {!active ? <Button onClick={start} disabled={!configured}><Mic size={18}/>{voice.connection === 'idle' ? 'Start voice session' : 'Start a new session'}</Button> : busy ? <Button variant="outline" onClick={() => session.current?.end()}>Cancel</Button> : <>
          {mode === 'thinking' ? voice.turnOpen ? <><Button disabled={!connected} onClick={() => session.current?.finishAnswer()}>Your turn</Button><Button variant="outline" disabled={!connected} onClick={() => session.current?.toggleMic()}>{voice.mic ? 'Pause mic' : 'Resume mic'}</Button></> : <Button disabled={!connected || voice.casePhase === 'finishing' || voice.generating && !voice.speaking} onClick={() => session.current?.startAnswer()}><Mic/>{voice.speaking ? 'Interrupt and speak' : 'Start my answer'}</Button> : <Button disabled={!connected || voice.casePhase === 'finishing'} onClick={() => session.current?.toggleMic()}>{voice.mic ? <MicOff/> : <Mic/>}{voice.mic ? 'Mute microphone' : voice.casePhase === 'feedback' ? 'Continue practising' : 'Open microphone'}</Button>}
          {(voice.speaking || voice.generating) && <Button variant="outline" disabled={!connected} onClick={() => session.current?.interrupt()}>Stop coach</Button>}
          <Button variant="outline" disabled={!connected || !voice.userTurns || voice.generating || voice.speaking || voice.userSpeaking || mode === 'thinking' && voice.turnOpen} onClick={() => session.current?.finishCase()}>Finish case &amp; get feedback</Button>
          <Button variant="outline" onClick={() => session.current?.end()}>End session</Button>
        </>}
        {voice.soundBlocked && <Button onClick={() => session.current?.enableSound()}><Volume2/>Enable coach audio</Button>}
      </div>
      {voice.error && <p className="error" role="alert">{voice.error}</p>}
      {voice.notice && <p className="notice" role="status">{voice.notice}</p>}
      <p className="muted">{voice.mic ? 'Your microphone is sending live audio to OpenAI.' : 'Your microphone is not sending audio.'}</p>
    </section>
    <section className="transcript" aria-label="Conversation transcript"><div className="transcript-heading"><h2>Transcript</h2><Button variant="ghost" onClick={downloadTranscript} disabled={!captions.length}><Download size={16}/>Save</Button></div>
      <div className="transcript-scroll" ref={transcript} role="log" aria-live="off" aria-label="Live captions" onScroll={event => { const el = event.currentTarget; followTranscript.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
        {!captions.length ? <p className="muted">Start a session, then tell the coach what you’re studying or ask it to give you a case.</p> : captions.map(c => <article key={c.id}><h3>{c.role === 'user' ? 'You' : 'Coach'}{c.interrupted && <span> · Interrupted; captions may include unplayed words</span>}</h3><p>{c.text || 'Caption arriving…'}</p></article>)}
      </div>
    </section>
    <details><summary>Voice, privacy and connection help</summary><p>Starting a session asks for microphone access. Natural conversation opens your microphone when connected; use “Mute microphone” to pause. Thinking space starts muted until you choose “Start my answer”. Live audio goes to OpenAI for coaching and captions. End session releases the microphone.</p><p>Allow microphone access in your browser’s site settings and Windows privacy settings. Headphones reduce echo. Use “Enable coach audio” if playback is blocked.</p><p>The app keeps captions in this tab, not on its server. Save them before reloading. A new session starts fresh with the coach. Captions can contain errors. <a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noreferrer">OpenAI API data policies</a> apply.</p><p>If you see a credit balance error, check <a href="https://platform.openai.com/settings/organization/billing" target="_blank" rel="noreferrer">OpenAI API billing</a>. Your ChatGPT subscription does not fund API usage.</p></details>
    <audio ref={audio} autoPlay playsInline hidden/>
  </main>;
}
