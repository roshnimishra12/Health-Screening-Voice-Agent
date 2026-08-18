import { buildInitialMessages, runConversationTurn } from "./services/openaiService.js";

function applyRecordUpdates(session, updates) {
  for (const update of updates) {
    if (update.name) session.patientRecord.name = update.name;
    if (update.chiefComplaint) session.patientRecord.chiefComplaint = update.chiefComplaint;
    if (update.durationDescription) session.patientRecord.durationDescription = update.durationDescription;
    if (update.severity) session.patientRecord.severity = update.severity;
    if (Array.isArray(update.otherSymptoms) && update.otherSymptoms.length) {
      const merged = new Set([...session.patientRecord.otherSymptoms, ...update.otherSymptoms]);
      session.patientRecord.otherSymptoms = [...merged];
    }
    if (update.flagForFollowUp) session.patientRecord.notes.push(update.flagForFollowUp);
  }
}

/**
 * Kick off the call: the AI speaks first (greeting + first question).
 */
export async function startCall(session) {
  session.messages = buildInitialMessages();
  // Nudge the model to open the call rather than waiting on a "user" turn.
  session.messages.push({
    role: "user",
    content: "[The call has just connected. Greet the patient and begin the intake.]",
  });

  const { assistantText, recordUpdates, messages } = await runConversationTurn(session.messages);
  session.messages = messages;
  applyRecordUpdates(session, recordUpdates);
  session.transcript.push({ speaker: "ai", text: assistantText, ts: Date.now() });
  return assistantText;
}

/**
 * Handle one user turn: userText is the STT output for what they just said
 * (may be empty string if STT heard nothing).
 */
export async function handleUserTurn(session, userText) {
  session.turnCount += 1;

  if (!userText || userText.trim().length === 0) {
    // Don't even call the LLM for genuine silence/empty STT — handle it
    // deterministically so a flaky STT result can't derail the conversation.
    const reply = "Sorry, I didn't catch that — could you say that again?";
    session.transcript.push({ speaker: "user", text: "[inaudible]", ts: Date.now() });
    session.transcript.push({ speaker: "ai", text: reply, ts: Date.now() });
    // Still keep the LLM's history in sync so it knows this exchange happened.
    session.messages.push({ role: "user", content: "[The patient's response was inaudible or silent.]" });
    session.messages.push({ role: "assistant", content: reply });
    return reply;
  }

  session.transcript.push({ speaker: "user", text: userText, ts: Date.now() });
  session.messages.push({ role: "user", content: userText });

  const { assistantText, recordUpdates, messages } = await runConversationTurn(session.messages);
  session.messages = messages;
  applyRecordUpdates(session, recordUpdates);
  session.transcript.push({ speaker: "ai", text: assistantText, ts: Date.now() });
  return assistantText;
}
