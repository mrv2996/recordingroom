import type { Feedback } from './drills';
export type CoachRequest={drillId:string;mode:'probe'|'feedback'|'retry';answer:string;followUp:string;followUpAnswer:string;original:string;priorFeedback:string};
async function responseData(response:Response){const data=await response.json() as Record<string,any>;if(!response.ok)throw new Error(data.error||'The request failed. Your answer is preserved.');return data;}
export async function coachStatus():Promise<boolean>{const data=await responseData(await fetch('/api/coach',{cache:'no-store'}));return data.configured;}
export async function transcribeRecording(audio:Blob):Promise<string>{const form=new FormData();form.set('audio',audio,audio.type.includes('mp4')?'answer.mp4':'answer.webm');const data=await responseData(await fetch('/api/transcribe',{method:'POST',body:form,signal:AbortSignal.timeout(70000)}));return data.text;}
export async function askCoach(request:CoachRequest):Promise<{question:string}|Feedback>{return await responseData(await fetch('/api/coach',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(70000)})) as Feedback|{question:string};}
