import { neon } from '@neondatabase/serverless';

let _sql;
function getSql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

let ready;
function ensure() {
  if (!ready) {
    ready = (async () => {
      const sql = getSql();
      await sql`CREATE TABLE IF NOT EXISTS projects (
        id text PRIMARY KEY,
        user_email text NOT NULL,
        name text NOT NULL,
        slots jsonb,
        created_at timestamptz DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS chats (
        id text PRIMARY KEY,
        user_email text NOT NULL,
        project_id text,
        title text NOT NULL,
        slots jsonb NOT NULL,
        messages jsonb NOT NULL DEFAULT '[]',
        updated_at timestamptz DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_email)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_email)`;
    })();
  }
  return ready;
}

export async function getData(email) {
  await ensure();
  const sql = getSql();
  const projects = await sql`SELECT id, name, slots FROM projects WHERE user_email=${email} ORDER BY created_at`;
  const chats = await sql`SELECT id, project_id AS "projectId", title, slots, messages FROM chats WHERE user_email=${email} ORDER BY updated_at DESC`;
  return { projects, chats };
}

export async function upsertChat(email, c) {
  await ensure();
  const sql = getSql();
  await sql`INSERT INTO chats (id, user_email, project_id, title, slots, messages, updated_at)
    VALUES (${c.id}, ${email}, ${c.projectId || null}, ${c.title || 'Chat'}, ${JSON.stringify(c.slots)}::jsonb, ${JSON.stringify(c.messages || [])}::jsonb, now())
    ON CONFLICT (id) DO UPDATE SET
      project_id = EXCLUDED.project_id,
      title = EXCLUDED.title,
      slots = EXCLUDED.slots,
      messages = EXCLUDED.messages,
      updated_at = now()
    WHERE chats.user_email = ${email}`;
}

export async function deleteChat(email, id) {
  await ensure();
  const sql = getSql();
  await sql`DELETE FROM chats WHERE id=${id} AND user_email=${email}`;
}

export async function upsertProject(email, p) {
  await ensure();
  const sql = getSql();
  await sql`INSERT INTO projects (id, user_email, name, slots)
    VALUES (${p.id}, ${email}, ${p.name}, ${p.slots ? JSON.stringify(p.slots) : null}::jsonb)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slots = EXCLUDED.slots
    WHERE projects.user_email = ${email}`;
}

export async function deleteProject(email, id) {
  await ensure();
  const sql = getSql();
  await sql`DELETE FROM projects WHERE id=${id} AND user_email=${email}`;
  await sql`UPDATE chats SET project_id=NULL WHERE project_id=${id} AND user_email=${email}`;
}
