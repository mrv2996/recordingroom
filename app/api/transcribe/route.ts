import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '@/app/chatgpt-auth';
export const dynamic='force-dynamic';
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(request:Request){
 if(!await getChatGPTUser())return json({error:'Please sign in to transcribe your answer.'},401);
 if(request.headers.get('origin')!==new URL(request.url).origin)return json({error:'Please use the app to send audio.'},403);
 const key=(env as unknown as {OPENAI_API_KEY?:string}).OPENAI_API_KEY;
 if(!key)return json({error:'AI transcription is not connected yet. You can replay your recording or type your answer.'},503);
 try{
  if(Number(request.headers.get('content-length')||0)>21*1024*1024)return json({error:'The recording is too large. Try a shorter answer.'},413);
  const data=await request.formData(),file=data.get('audio');
  if(!(file instanceof File)||file.size<500||file.size>20*1024*1024||!['audio/webm','audio/mp4','audio/wav'].includes(file.type.split(';')[0]))return json({error:'Send a WebM, MP4 or WAV recording under 20 MB.'},400);
  const form=new FormData();form.set('file',file);form.set('model','gpt-4o-mini-transcribe');form.set('response_format','json');
  const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(60000)});
  if(!response.ok)return json({error:'Transcription is unavailable. Your recording is still here; retry or type your answer.'},502);
  const result=await response.json() as {text?:string};if(!result.text?.trim())return json({error:'No speech was recognised. Try again or type your answer.'},422);
  return json({text:result.text});
 }catch{return json({error:'Transcription did not finish. Your recording is preserved; please try again.'},502);}
}
