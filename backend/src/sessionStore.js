// Simple in-memory session store.
// A "session" = one phone call. Good enough for a take-home assessment;
// in production this would live in Redis/Postgres so it survives restarts
// and works across multiple server instances.

const sessions = new Map();

export function createSession(sessionId) {
  const session = {
    id: sessionId,
    createdAt: Date.now(),
    // Full chat history sent to the LLM (system + user + assistant + tool messages)
    messages: [],
    // Structured fields the LLM fills in via function calling as the call progresses.
    // This is what lets us avoid re-asking a question that's already been answered.
    patientRecord: {
      name: null,
      chiefComplaint: null,
      durationDescription: null,
      severity: null, // e.g. "mild" | "moderate" | "severe" | "7/10"
      otherSymptoms: [],
      notes: [], // anything the AI flagged as worth a human following up on
    },
    // Plain-English transcript for report generation / debugging, independent of
    // the LLM message format (which includes tool call plumbing we don't want to show).
    transcript: [], // { speaker: 'ai' | 'user', text: string, ts: number }
    turnCount: 0,
    ended: false,
  };
  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId) {
  return sessions.get(sessionId);
}

export function deleteSession(sessionId) {
  sessions.delete(sessionId);
}
