# Consulting voice coach

A basic desktop voice trainer for consulting courses and case practice. The AI is instructed to coach in an experienced MBB consultant's style; it has no actual firm employment history or affiliation. This is prompting, not model fine-tuning.

## Start and use

1. Open a terminal in this project's `work` folder.
2. With Node.js 24 and npm installed, run `npm install` once, then `npm run dev`. On this computer, the existing bundled launcher also works: `..\tooling\npm.cmd run dev`.
3. Open http://localhost:5173. Local development uses the starter's loopback-only mock sign-in; deployed Sites uses authenticated ChatGPT identity.
4. Choose **Open consulting practice** and **Natural conversation**. Press **Start voice session** and allow microphone access. Natural conversation opens the microphone when connected. Speak naturally; use **Mute microphone** to pause. Thinking space starts muted.
5. Tell it what you are studying, or ask for a practice case. It listens to your attempt, asks 2–3 follow-ups one at a time, then invites your recommendation. Press **Finish case & get feedback** when the coach has stopped speaking to receive your review. This mutes the microphone without disconnecting. Use **Continue practising** for a retry.
6. For longer pauses, choose **Thinking space** before starting. Press **Start my answer**, then **Your turn** when finished. **Pause mic** preserves the current turn.
7. **End session** closes the connection and releases the microphone. Save captions before reloading. New sessions do not remember previous sessions.

## API key and account status

The server reads `work/.env`. The permanent key must be set only here, never in client code or a `VITE_` / `NEXT_PUBLIC_` variable:

```dotenv
OPENAI_API_KEY=your-key-goes-here
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
```

Do not overwrite an existing `.env` with the example file. Restart the development server after changing credentials. `.env` is ignored by Git; `.env.example` has no key. For deployment, set an encrypted server-side environment secret on the hosting platform; local `.env` is not a deployment configuration.

On 28 September 2026, after credits were added, the configured key successfully minted a Realtime credential and a live API test returned a completed spoken response with transcript text. The earlier `credit_balance_exhausted` error is resolved. Check [OpenAI API billing](https://platform.openai.com/settings/organization/billing) in the organization owning this key, and [limits](https://platform.openai.com/settings/organization/limits) if a spending cap applies. ChatGPT subscription billing is separate. No key rotation is indicated by this error.

## How it works

- `app/api/realtime/session/route.ts` authenticates the user, checks same-origin requests and inputs, applies a small per-user rate limit, and exchanges the server key for a short-lived client credential. It never returns the permanent key or logs credentials. Responses use `Cache-Control: no-store`.
- `lib/realtime-config.ts` holds the coaching instructions, model, voice, input transcription and turn-taking settings.
- `lib/realtime-client.ts` owns browser microphone permission, the WebRTC connection, remote audio playback, the `oai-events` data channel and cleanup. The browser sends its SDP offer directly to OpenAI's `/v1/realtime/calls` using the ephemeral credential. Audio streams directly over WebRTC.
- `lib/realtime-events.ts` handles asynchronous captions without reordering the conversation. Transcription provides captions; it does not drive a text-to-speech request loop.
- `components/voice-coach.tsx` provides basic session controls and the transcript. Existing legacy `/api/coach` and `/api/transcribe` routes are not used by this screen.

## Developer notes

**Latency:** Reuse one WebRTC connection for the conversation. No separate recording/upload/LLM/TTS pipeline is involved. Natural conversation uses semantic VAD with low eagerness, allowing more thinking time. Shorter pauses can be configured with medium eagerness at the cost of more interruptions. Coach replies are deliberately concise. Thinking space turns VAD off and commits only on **Your turn**, then waits for the server acknowledgement before requesting a response. A 200 ms drain allows trailing audio packets to arrive before commit; tune using actual network/audio tests.

**Session lifecycle:** Request microphone permission before minting the token so time spent in the permission prompt does not consume the credential's validity. Natural conversation opens the mic on connection; thinking space starts muted. End, cancel, failed handshake, lost connection, disconnected mic and unmount stop all tracks and close the peer/data channel. A late permission grant after cancellation is immediately released. There is a 30-second connection timeout, an 8-second network recovery window and a 55-minute application session limit. OpenAI documents a 60-minute maximum. Reconnect mints a new credential and starts a fresh conversation; visible old captions are not silently replayed.

**Permissions:** Use localhost or HTTPS and a current desktop browser supporting WebRTC. Allow site microphone access and the Windows microphone setting for the browser/app. Headphones reduce echo. If playback is blocked by autoplay policy, **Enable coach audio** retries playback from a click. Caption updates do not force screen-reader announcements over the voice response.

**Recovery:** Mic denial/unplugging, missing/invalid keys, model access, quota exhaustion, throttling, connection timeouts and playback denial have distinct user-facing messages. Credit exhaustion requires account action; retrying immediately is not a fix. Repeated requests are not automatically retried. Natural mode mute clears pending uncommitted input; thinking-mode pause retains it. Stopping or interrupting the coach clears queued WebRTC audio. Interrupted captions may include words that never played.

**Storage and deployment:** Transcripts remain in memory until the user saves them locally. No application recording or transcript database is used. OpenAI's [API data policies](https://developers.openai.com/api/docs/guides/your-data) apply. Ephemeral credentials stay in memory, not local storage. The local rate limiter is per worker, not a production-wide spending boundary. Before multi-user deployment use a shared limiter, appropriate account limits, HTTPS and the hosting platform's trusted identity headers; never expose local mock authentication publicly. UI defaults, prompts and ephemeral session configuration are not enforcement of billing limits.

## Validation

Run `npm run test:realtime` for the automated transport/state tests (Node.js 24). Run `npm run build` and `npx tsc --noEmit` for build/type checks. With the local server running and API credits available, `npm run test:realtime:live` performs a real token exchange and a brief synthetic-text-to-audio API check without capturing the physical microphone. The live check incurs API usage and does not replace a browser WebRTC/audio test.

Completed: type checking; 14 automated tests for caption ordering, manual turn commits, cancellation cleanup, server errors, network recovery, autoplay recovery and quota classification; real credential minting; real rejection of anonymous and cross-origin requests. A live API check returned audio and captions successfully after credits were added. A browser test using the production WebRTC client and a silent synthetic microphone also passed: connected, received coach audio, displayed 217 caption characters and played 14.5 seconds of audio. The temporary browser diagnostic was removed. Physical microphone quality still requires a user test.

Manual checklist:

- [ ] Grant microphone permission, hear the greeting, open the mic and receive a relevant spoken response.
- [ ] Deny permission, verify an actionable message, grant permission and reconnect.
- [ ] Mute/end the session and confirm the browser microphone indicator stops appropriately; ending releases the device.
- [ ] In thinking space, pause for 10 seconds without a coach interruption, then press **Your turn**. Check the final word is captured.
- [ ] In natural conversation, interrupt the coach; queued audio should stop and the coach should respond to the new thought.
- [ ] Block autoplay, then recover with **Enable coach audio**.
- [ ] Disconnect the network briefly and reconnect. For a longer interruption, verify cleanup and a fresh-session option without losing visible captions.
- [ ] Cancel while the permission prompt is open; granting permission later must not leave the mic open.
- [ ] Practise a course question and each built-in scenario. Check one follow-up at a time, feedback grounded in your answer, no complete model answer before retry, numerical consistency, and a useful comparison after retry.
- [ ] Verify the browser never receives the permanent key; only the short-lived credential should appear in the session response.

Implementation guidance checked against the official [models directory](https://developers.openai.com/api/docs/models), [WebRTC guide](https://developers.openai.com/api/docs/guides/voice-webrtc), [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) and [voice activity detection](https://developers.openai.com/api/docs/guides/realtime-vad).

## Critical, diagnosis-first coaching update

The policy now lives in `lib/coaching-policy.ts` and is shared with the finish-case feedback request. It prioritises question quality, competing hypotheses, discriminating evidence, root-cause analysis and recommendations that address a demonstrated cause. The 2–3 challenge-question budget does not force a premature recommendation; an incomplete diagnosis is reviewed as incomplete.

A four-turn synthetic text evaluation on 28 September 2026 challenged immediate enforcement, asked for an operational definition of attendance, rejected an unsupported disengagement inference, and gave evidence-based feedback. The dialogue is saved in `../outputs/Coaching-evaluation.md`. The test also exposed repetitive AI introductions; the policy was tightened afterwards to introduce itself once and avoid routine preambles. That final wording refinement has not had a second paid evaluation. Run `node --experimental-transform-types scripts/coaching-eval.mjs --live` only when you intentionally want another paid text-only check.

Learning materials belong in `../materials/`, outside the app's served content. Nothing is auto-uploaded or ingested. Review selected material in Codex and distil it into the coaching policy instead of loading whole casebooks into every voice session.

For the Windows local launcher and update behaviour, see `../outputs/Using-your-coach.md`. The launcher only starts/reuses the local server and opens Edge/Chrome in app mode. `/api/health` identifies this app without exposing credentials or calling OpenAI. `--no-open` checks startup/reuse without opening a browser. Local server startup uses localhost and a strict port; it must never fall back to publicly exposing the mock-auth server.