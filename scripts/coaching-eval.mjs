// Opt-in live check. Uses synthetic text only, never a physical microphone or user files.
import { writeFile } from 'node:fs/promises';
import { FINISH_CASE_MESSAGE } from '../lib/coaching-policy.ts';
if (!process.argv.includes('--live')) throw new Error('Pass --live to run this paid API check.');
const diagnostic = process.argv.includes('--diagnostic');
const origin = 'http://localhost:5173';
const headers = { Origin: origin, Cookie: '__sites_local_auth=1', 'Content-Type': 'application/json' };
const status = await fetch(`${origin}/api/realtime/session`, { headers }).then(r => r.json());
const response = await fetch(`${origin}/api/realtime/session`, { method: 'POST', headers, body: JSON.stringify({ drillId: diagnostic ? 'diagnostic' : 'all-hands', mode: 'thinking' }), signal: AbortSignal.timeout(30000) });
const token = await response.json();
if (!response.ok || !token.value) throw new Error(`Session setup failed: ${token.code || response.status}`);
const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(status.model)}`, ['realtime', `openai-insecure-api-key.${token.value}`]);
const turns = [];
let pending;
ws.addEventListener('message', message => {
  const event = JSON.parse(message.data);
  if (event.type === 'error') pending?.reject(new Error(`Realtime error: ${event.error?.code || 'unknown'}`));
  if (event.type === 'response.output_text.delta' && pending) pending.text += event.delta || '';
  if (event.type === 'response.done' && pending) {
    const job = pending; pending = undefined;
    if (event.response?.status !== 'completed') job.reject(new Error(`Response did not complete: ${event.response?.status}`));
    else job.resolve(job.text);
  }
});
async function ask(text) {
  const answer = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending = undefined; reject(new Error('Coaching response timed out')); }, 45000);
    pending = { text: '', resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } };
    if (text) ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
    ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['text'], max_output_tokens: 650 } }));
  });
  turns.push({ learner: text, coach: answer });
  console.log(JSON.stringify({ turn: turns.length, coach: answer }));
}
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timed out')), 20000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Connection failed')); }, { once: true });
  });
  if (diagnostic) {
    await ask(''); // Same greeting trigger as the browser: no user message yet.
    await ask('I have seen this before. I would train the salespeople and automate follow-ups immediately. That should fix it.');
    await ask('What outcome are we trying to improve, how is sales cycle defined, and what baseline and target are we using?');
    await ask('Where in the process has the additional time appeared? I want the before-and-after average duration for each stage so I can locate the increase.');
    await ask('My alternatives are more cases arriving, more work or rework per case, and reduced processing capacity. Could I have more data about the customers?');
    await ask('I would compare incoming legal cases with completions per week, and active handling time with queue time, in each quarter. Stable work per case with more arrivals would support a demand explanation; increased handling or rework at stable arrivals would support complexity. Is that available?');
    await ask('My diagnostic summary: the objective is to return the won-deal sales cycle from 52 to 40 days without harming win rate or discounting. The extra 12 days appear in legal review, but that locates the delay without proving its cause. Demand, work per case, and capacity remain alternatives. I would get the workload and time comparisons I requested before recommending an intervention. I cannot yet claim a root cause.');
    await ask(FINISH_CASE_MESSAGE);
    await ask('I want to move on to a fresh full profitability case now, including structuring and recommendations. Please start that case.');
  } else {
  await ask('For this all-hands case I would immediately mandate attendance and send more reminders. That should solve it.');
  await ask('I should first clarify whether success means live attendance or useful employee participation. I would compare attendance by time zone over six months, and distinguish scheduling conflicts from low relevance. What attendance breakdown by time zone is available?');
  await ask('Suppose Europe attends at 70%, the US at 65% and Asia at 20%. That proves Asia is disengaged, so I recommend compulsory cameras.');
  await ask(FINISH_CASE_MESSAGE);
  }
  const report = '# Critical coaching check\n\nSynthetic text-only dialogue; no user material or microphone audio was submitted. Inspect responses for unsupported praise, invented case data, leading questions, premature recommendations, and evidence-based critique.\n\n' + turns.map((turn, i) => `## Turn ${i + 1}\n\nLearner: ${turn.learner}\n\nCoach: ${turn.coach}\n`).join('\n');
  await writeFile(new URL(diagnostic ? '../../outputs/Diagnostic-practice-evaluation.md' : '../../outputs/Coaching-evaluation.md', import.meta.url), report, 'utf8');
} finally { ws.close(); }
