CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'group_poll',
  status TEXT NOT NULL DEFAULT 'Open',
  timezone TEXT NOT NULL DEFAULT 'Europe/Zurich',
  deadline TEXT NOT NULL DEFAULT '',
  reminders INTEGER NOT NULL DEFAULT 0,
  hide_participants INTEGER NOT NULL DEFAULT 0,
  meeting_link TEXT NOT NULL DEFAULT '',
  booked_session_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS events_owner_created ON events(owner_key, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL DEFAULT '',
  duration TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_event ON sessions(event_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 1,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS responses_event ON responses(event_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS response_sessions (
  response_id TEXT NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (response_id, session_id)
);
