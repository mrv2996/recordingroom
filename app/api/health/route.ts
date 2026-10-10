import { COACH_POLICY_VERSION } from '@/lib/coaching-policy';

export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ app: 'consulting-voice-coach', status: 'ready', coachingVersion: COACH_POLICY_VERSION }, { headers: { 'Cache-Control': 'no-store' } });
}
