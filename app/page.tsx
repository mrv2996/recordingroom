import { requireChatGPTUser } from '@/app/chatgpt-auth';
import VoiceCoach from '@/components/voice-coach';

export const dynamic = 'force-dynamic';
export default async function Home() {
  await requireChatGPTUser('/');
  return <VoiceCoach/>;
}
