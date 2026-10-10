import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {coachingInput,instructions,scenario,probeSchema,feedbackSchema,parsedFeedback,quotesAreGrounded} from '@/lib/coaching';
export const dynamic='force-dynamic';
const settings=()=>env as unknown as {OPENAI_API_KEY?:string;OPENAI_COACH_MODEL?:string};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(){return json({configured:Boolean(settings().OPENAI_API_KEY)});}
export async function POST(request:Request){
 if(!await getChatGPTUser())return json({error:'Please sign in to use your private coach.'},401);
 if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Please send this answer from the app.'},403);
 const key=settings().OPENAI_API_KEY;
 if(!key)return json({error:'The AI coach is not connected yet. Your answer is still here. Complete the secure OpenAI setup in Codex to enable coaching.'},503);
 try{
  if(Number(request.headers.get('content-length')||0)>80000)return json({error:'This answer is too long. Shorten it and try again.'},413);
  const raw=await request.text();if(raw.length>80000)return json({error:'This answer is too long.'},413);
  let decoded:unknown;try{decoded=JSON.parse(raw);}catch{return json({error:'The answer could not be read. Please try again.'},400);}
  const input=coachingInput.safeParse(decoded);if(!input.success)return json({error:input.error.issues[0].message},400);const v=input.data;
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:AbortSignal.timeout(60000),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:settings().OPENAI_COACH_MODEL||'gpt-4o',store:false,max_output_tokens:2200,instructions:instructions(v.mode),input:JSON.stringify({scenario:scenario(v.drillId),...v}),text:{format:{type:'json_schema',name:v.mode==='probe'?'probe':'feedback',strict:true,schema:v.mode==='probe'?probeSchema:feedbackSchema}}})});
  if(!response.ok)return json({error:response.status===429?'The AI service is busy or its usage limit has been reached. Your answer is preserved; try again later.':'The coach could not respond. Check the OpenAI connection in Codex, then try again.'},502);
  const result=await response.json() as {status:string;output?:Array<{content?:Array<{type:string;text?:string}>}>};
  if(result.status!=='completed')return json({error:'The coach did not finish. Your answer is preserved; please try again.'},502);
  const text=result.output?.flatMap(o=>o.content??[]).filter(c=>c.type==='output_text').map(c=>c.text??'').join('')??'';const data=JSON.parse(text);
  if(v.mode==='probe'){if(typeof data.question!=='string'||!data.question.trim()||data.question.length>1500)throw new Error('Invalid question');return json(data);}
  const feedback=parsedFeedback.parse(data);
  if(!quotesAreGrounded(feedback,v.answer+'\n'+(v.mode==='retry'?'':v.followUpAnswer)))return json({error:'The coach returned evidence that could not be matched to your answer. Please try again.'},502);
  return json(feedback);
 }catch{return json({error:'The coach could not finish this request. Your answer is preserved. Please try again.'},502);}
}
