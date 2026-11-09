const HTML = __HTML__;
const json = (data, status = 200, request = null) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": request?.headers.get("origin") || "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-owner-token"
  }
});
const bad = (message, status = 400, request = null) => json({ error: message }, status, request);
const one = (result) => result?.results?.[0] || null;
const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const iso = () => new Date().toISOString();

async function hydrateEvent(db, row, ownerMode) {
  if (!row) return null;
  const [sessionResult, responseResult] = await Promise.all([
    db.prepare("SELECT id,name,date,time,duration,capacity FROM sessions WHERE event_id=? ORDER BY rowid").bind(row.id).all(),
    db.prepare("SELECT r.id,r.name,r.seats,r.comment,r.created_at,group_concat(rs.session_id) AS selected FROM responses r LEFT JOIN response_sessions rs ON rs.response_id=r.id WHERE r.event_id=? GROUP BY r.id ORDER BY r.created_at,r.rowid").bind(row.id).all()
  ]);
  const responses = (responseResult.results || []).map(r => {
    const result = { id: r.id, name: r.name, seats: r.seats, selected: (r.selected || "").split(",").filter(Boolean) };
    if (ownerMode) result.comment = r.comment || "";
    return result;
  });
  return {
    id: row.id, title: row.title, description: row.description, date: row.date,
    location: row.location, owner: row.owner, kind: row.kind, status: row.status,
    timezone: row.timezone, deadline: row.deadline, reminders: !!row.reminders,
    hideParticipants: !!row.hide_participants, meetingLink: row.meeting_link, imageKey: row.image_key || "", maxSelections: Number(row.max_selections || 0),
    bookedSessionId: row.booked_session_id,
    sessions: sessionResult.results || [],
    responses: (!ownerMode && row.hide_participants) ? [] : responses
  };
}

async function ownerEvents(db, ownerKey) {
  const result = await db.prepare("SELECT * FROM events WHERE owner_key=? ORDER BY created_at DESC").bind(ownerKey).all();
  const out = [];
  for (const row of (result.results || [])) out.push(await hydrateEvent(db, row, true));
  return out;
}

function validSession(s) {
  return s && clean(s.id, 80) && clean(s.name, 120);
}

async function api(request, env, url) {
  const db = env.DB;
  if (!db) return bad("Shared storage is not connected yet.", 503, request);
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const ownerKey = clean(request.headers.get("x-owner-token"), 120);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": request.headers.get("origin") || "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-owner-token"
  }});
  if (path === "/api/images" && request.method === "POST") {
    if (!ownerKey) return bad("Owner profile required", 401, request);
    if (!env.BUCKET) return bad("Image storage is unavailable", 503, request);
    const mime = request.headers.get("content-type") || "";
    if (!["image/jpeg","image/png","image/webp"].includes(mime)) return bad("Choose a JPEG, PNG or WebP image", 415, request);
    const data = await request.arrayBuffer();
    if (!data.byteLength || data.byteLength > 5 * 1024 * 1024) return bad("Choose an image smaller than 5 MB", 413, request);
    const key = crypto.randomUUID();
    await env.BUCKET.put(key, data, {httpMetadata:{contentType:mime}});
    return json({key}, 201, request);
  }
  const imageMatch = path.match(/^\/api\/images\/([0-9a-f-]{36})$/);
  if (imageMatch && request.method === "GET") {
    const object = await env.BUCKET?.get(imageMatch[1]);
    if (!object) return bad("Image not found", 404, request);
    return new Response(object.body, {headers:{"content-type":object.httpMetadata?.contentType || "application/octet-stream","cache-control":"public, max-age=31536000, immutable","x-content-type-options":"nosniff"}});
  }
  if (path === "/api/events" && request.method === "GET") {
    if (!ownerKey) return json({ error: "Owner profile required" }, 401, request);
    return json(await ownerEvents(db, ownerKey), 200, request);
  }
  if (path === "/api/events" && request.method === "POST") {
    if (!ownerKey) return bad("Owner profile required", 401, request);
    let body; try { body = await request.json(); } catch { return bad("Invalid event details", 400, request); }
    const title = clean(body.title, 90), sessions = Array.isArray(body.sessions) ? body.sessions.filter(validSession).slice(0, 100) : [];
    if (!title || !sessions.length) return bad("Add an event name and at least one time option", 422, request);
    const maxSelections = body.maxSelections == null ? 0 : Number(body.maxSelections);
    if (!Number.isInteger(maxSelections) || maxSelections < 0 || maxSelections > sessions.length) return bad("The selection limit must be between 1 and the number of options", 422, request);
    const id = clean(body.id, 80) || crypto.randomUUID();
    const stmts = [db.prepare("INSERT INTO events(id,owner_key,title,description,date,location,owner,kind,status,timezone,deadline,reminders,hide_participants,meeting_link,image_key,max_selections) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, ownerKey, title, clean(body.description), clean(body.date, 20), clean(body.location), clean(body.owner, 80), ["signup_sheet", "text_options"].includes(body.kind) ? body.kind : "group_poll", "Open", clean(body.timezone, 80) || "Europe/Zurich", clean(body.deadline, 40), body.reminders ? 1 : 0, body.hideParticipants ? 1 : 0, clean(body.meetingLink, 300), /^[0-9a-f-]{36}$/.test(body.imageKey || "") ? body.imageKey : "", maxSelections)];
    for (const s of sessions) stmts.push(db.prepare("INSERT INTO sessions(id,event_id,name,date,time,duration,capacity) VALUES(?,?,?,?,?,?,?)")
      .bind(clean(s.id, 80), id, clean(s.name, 120), clean(s.date, 20), clean(s.time, 40), clean(s.duration, 30), Math.max(0, Math.min(99999, Number(s.capacity) || 0))));
    try { await db.batch(stmts); return json(await hydrateEvent(db, one(await db.prepare("SELECT * FROM events WHERE id=?").bind(id).all()), true), 201, request); }
    catch (e) { return bad("Could not save this event. Check the event ID and try again.", 409, request); }
  }
  const match = path.match(/^\/api\/events\/([^/]+)(?:\/responses\/([^/]+))?$/);
  if (!match) return bad("Not found", 404, request);
  const eventId = decodeURIComponent(match[1]);
  const responseId = match[2] ? decodeURIComponent(match[2]) : null;
  const row = one(await db.prepare("SELECT * FROM events WHERE id=?").bind(eventId).all());
  if (!row) return bad("This poll link could not be found", 404, request);
  const isOwner = !!ownerKey && ownerKey === row.owner_key;
  if (!responseId && request.method === "GET") return json(await hydrateEvent(db, row, isOwner), 200, request);
  if (!responseId && request.method === "PATCH") {
    if (!isOwner) return bad("Only the poll owner can change this event", 403, request);
    let body; try { body = await request.json(); } catch { return bad("Invalid update", 400, request); }
    const status = body.status === "Closed" ? "Closed" : body.status === "Open" ? "Open" : row.status;
    const booked = body.bookedSessionId === null ? "" : clean(body.bookedSessionId ?? row.booked_session_id, 80);
    if (booked && !(await db.prepare("SELECT id FROM sessions WHERE id=? AND event_id=?").bind(booked, eventId).first())) return bad("Choose a valid time option", 422, request);
    await db.prepare("UPDATE events SET status=?,booked_session_id=? WHERE id=?").bind(status, booked, eventId).run();
    return json(await hydrateEvent(db, one(await db.prepare("SELECT * FROM events WHERE id=?").bind(eventId).all()), true), 200, request);
  }
  if (!responseId && request.method === "PUT") {
    if (!isOwner) return bad("Only the poll owner can edit this event", 403, request);
    let body; try { body = await request.json(); } catch { return bad("Invalid event details", 400, request); }
    const sessions = Array.isArray(body.sessions) ? body.sessions.filter(validSession).slice(0, 100) : [];
    const title = clean(body.title, 90);
    if (!title || !sessions.length) return bad("Add an event name and at least one time option", 422, request);
    const maxSelections = body.maxSelections == null ? 0 : Number(body.maxSelections);
    if (!Number.isInteger(maxSelections) || maxSelections < 0 || maxSelections > sessions.length) return bad("The selection limit must be between 1 and the number of options", 422, request);
    const stmts = [db.prepare("UPDATE events SET title=?,description=?,date=?,location=?,owner=?,kind=?,timezone=?,deadline=?,reminders=?,hide_participants=?,meeting_link=?,image_key=?,max_selections=? WHERE id=?")
      .bind(title, clean(body.description), clean(body.date, 20), clean(body.location), clean(body.owner, 80), ["signup_sheet", "text_options"].includes(body.kind) ? body.kind : "group_poll", clean(body.timezone, 80) || "Europe/Zurich", clean(body.deadline, 40), body.reminders ? 1 : 0, body.hideParticipants ? 1 : 0, clean(body.meetingLink, 300), /^[0-9a-f-]{36}$/.test(body.imageKey || "") ? body.imageKey : "", maxSelections, eventId)];
    for (const s of sessions) stmts.push(db.prepare("INSERT INTO sessions(id,event_id,name,date,time,duration,capacity) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,date=excluded.date,time=excluded.time,duration=excluded.duration,capacity=excluded.capacity WHERE sessions.event_id=excluded.event_id")
      .bind(clean(s.id, 80), eventId, clean(s.name, 120), clean(s.date, 20), clean(s.time, 40), clean(s.duration, 30), Math.max(0, Math.min(99999, Number(s.capacity) || 0))));
    const ids = sessions.map(s => clean(s.id, 80));
    const deleteStmt = ids.length
      ? db.prepare(`DELETE FROM sessions WHERE event_id=? AND id NOT IN (${ids.map(() => "?").join(",")})`).bind(eventId, ...ids)
      : db.prepare("DELETE FROM sessions WHERE event_id=?").bind(eventId);
    stmts.push(deleteStmt);
    try { await db.batch(stmts); return json(await hydrateEvent(db, one(await db.prepare("SELECT * FROM events WHERE id=?").bind(eventId).all()), true), 200, request); }
    catch { return bad("Could not update this poll. Keep at least one option and try again.", 409, request); }
  }
  if (!responseId && request.method === "DELETE") {
    if (!isOwner) return bad("Only the poll owner can delete this event", 403, request);
    await db.prepare("DELETE FROM events WHERE id=?").bind(eventId).run();
    return json({ ok: true }, 200, request);
  }
  if (responseId && request.method === "DELETE") {
    if (!isOwner) return bad("Only the poll owner can remove responses", 403, request);
    await db.prepare("DELETE FROM responses WHERE id=? AND event_id=?").bind(responseId, eventId).run();
    return json({ ok: true }, 200, request);
  }
  if (!responseId && request.method === "POST") {
    if (row.status !== "Open") return bad("This poll is closed", 409, request);
    if (row.deadline && new Date(row.deadline).getTime() < Date.now()) return bad("The response deadline has passed", 409, request);
    let body; try { body = await request.json(); } catch { return bad("Invalid response", 400, request); }
    const name = clean(body.name, 80), seats = Math.max(1, Math.min(99, Number(body.seats) || 1));
    const selected = Array.isArray(body.selected) ? [...new Set(body.selected.map(x => clean(x, 80)))] : [];
    if (!name || !selected.length) return bad("Add your name and choose at least one option", 422, request);
    if (row.max_selections > 0 && selected.length > row.max_selections) return bad(`Choose no more than ${row.max_selections} option${row.max_selections === 1 ? "" : "s"}`, 422, request);
    const sessionRows = (await db.prepare("SELECT id,capacity FROM sessions WHERE event_id=?").bind(eventId).all()).results || [];
    if (selected.some(id => !sessionRows.some(s => s.id === id))) return bad("One of the selected options has changed. Reload and try again.", 409, request);
    for (const sid of selected) {
      const sess = sessionRows.find(s => s.id === sid);
      if (Number(sess.capacity) > 0) {
        const current = one(await db.prepare("SELECT COALESCE(SUM(r.seats),0) AS n FROM responses r JOIN response_sessions rs ON rs.response_id=r.id WHERE rs.session_id=?").bind(sid).all());
        if (Number(current?.n || 0) + seats > Number(sess.capacity)) return bad("That option has reached its seat limit. Choose fewer seats or another time.", 409, request);
      }
    }
    const id = crypto.randomUUID();
    const stmts = [db.prepare("INSERT INTO responses(id,event_id,name,seats,comment) VALUES(?,?,?,?,?)").bind(id, eventId, name, seats, clean(body.comment, 300))];
    for (const sid of selected) stmts.push(db.prepare("INSERT INTO response_sessions(response_id,session_id) VALUES(?,?)").bind(id, sid));
    await db.batch(stmts);
    return json({ ok: true, id }, 201, request);
  }
  return bad("Method not allowed", 405, request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env, url);
    if (request.method === "GET" || request.method === "HEAD") return new Response(HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" }
    });
    return new Response("Method not allowed", { status: 405 });
  }
};
