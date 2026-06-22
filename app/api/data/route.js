import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../../auth';
import { getData, upsertChat, deleteChat, upsertProject, deleteProject } from '../../../lib/db';

export const runtime = 'nodejs';

async function email() {
  const session = await getServerSession(authOptions);
  return session?.user?.email || null;
}

export async function GET() {
  const e = await email();
  if (!e) return new Response('Unauthorized', { status: 401 });
  try {
    const data = await getData(e);
    return Response.json(data);
  } catch (err) {
    return new Response(String(err?.message || err), { status: 500 });
  }
}

export async function POST(req) {
  const e = await email();
  if (!e) return new Response('Unauthorized', { status: 401 });
  const b = await req.json();
  try {
    if (b.action === 'upsertChat') await upsertChat(e, b.chat);
    else if (b.action === 'deleteChat') await deleteChat(e, b.id);
    else if (b.action === 'upsertProject') await upsertProject(e, b.project);
    else if (b.action === 'deleteProject') await deleteProject(e, b.id);
    else return new Response('Bad action', { status: 400 });
    return Response.json({ ok: true });
  } catch (err) {
    return new Response(String(err?.message || err), { status: 500 });
  }
}
