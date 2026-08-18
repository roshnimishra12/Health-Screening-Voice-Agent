import OpenAI from "openai";
import { toFile } from "openai/uploads";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const TTS_VOICE = process.env.TTS_VOICE || "alloy";

/**
 * Transcribe a single turn of user audio.
 * @param {Buffer} audioBuffer - raw audio bytes (webm/opus from the browser MediaRecorder)
 * @param {string} filename - e.g. "turn.webm", used so Whisper can infer the container format
 * @returns {Promise<string>} transcribed text (may be empty string on silence)
 */
export async function transcribeAudio(audioBuffer, filename = "turn.webm") {
  if (!audioBuffer || audioBuffer.length < 500) {
    // Too small to plausibly contain speech (roughly < ~0.05s of audio) — don't
    // waste an API call, just treat it as silence.
    return "";
  }
  try {
    const file = await toFile(audioBuffer, filename);
    const result = await client.audio.transcriptions.create({
      file,
      model: "whisper-1",
      language: "en",
    });
    return (result.text || "").trim();
  } catch (err) {
    console.error("[STT] transcription failed:", err.message);
    throw new Error("STT_FAILED");
  }
}

/**
 * Convert text to speech and return raw audio bytes (mp3).
 */
export async function synthesizeSpeech(text) {
  try {
    const response = await client.audio.speech.create({
      model: "tts-1",
      voice: TTS_VOICE,
      input: text,
      response_format: "mp3",
    });
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error("[TTS] synthesis failed:", err.message);
    throw new Error("TTS_FAILED");
  }
}

// The LLM calls this tool whenever it learns (or updates) a piece of intake info.
// Keeping structured state OUT of free-form text is what lets the backend track
// "what's already been asked/answered" reliably instead of hoping the model
// remembers correctly across turns.
export const UPDATE_RECORD_TOOL = {
  type: "function",
  function: {
    name: "update_patient_record",
    description:
      "Record or update a piece of the patient's intake information as soon as it is learned from the conversation. Call this every time the user provides a new fact, even a partial one. Only include fields you actually learned this turn.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Patient's name" },
        chiefComplaint: {
          type: "string",
          description: "The main symptom or concern, in a few words",
        },
        durationDescription: {
          type: "string",
          description: "How long the issue has been going on, e.g. '3 days', 'about a week'",
        },
        severity: {
          type: "string",
          description: "Severity as described or rated by the patient, e.g. 'mild', 'moderate', '7/10'",
        },
        otherSymptoms: {
          type: "array",
          items: { type: "string" },
          description: "Any additional related symptoms mentioned",
        },
        flagForFollowUp: {
          type: "string",
          description:
            "Anything concerning or ambiguous worth a clinician double-checking (e.g. possible red-flag symptom, contradictory answers). Omit if nothing stands out.",
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a warm, professional voice assistant conducting a basic health-screening intake call, similar to what a clinic receptionist or triage nurse would do before a doctor's visit. You are NOT a doctor and must never diagnose or give medical advice — you are only gathering information.

Conduct the call in English.

Ask about, one at a time, in a natural adaptive order (not necessarily this exact order):
1. The patient's name
2. Their main concern or symptom today
3. How long it's been going on
4. How severe it is
5. Any other related symptoms

Rules:
- Ask ONE question at a time. Keep each turn short (1-2 sentences) — this is a spoken phone call, not a chat.
- Listen to the actual answer. If it's vague (e.g. "it hurts sometimes"), ask a brief, natural follow-up before moving on — don't just march to the next scripted question.
- Never re-ask something already answered. Check what you already know before asking.
- Call the update_patient_record function every time you learn or refine a piece of information, in the SAME turn you learn it.
- If the user says something alarming (e.g. chest pain, difficulty breathing, thoughts of self-harm), gently note it via flagForFollowUp and calmly let them know a clinician will review this soon — do not attempt to handle an emergency yourself, and if it sounds urgent, suggest they contact emergency services.
- Once you've gathered the key fields (or the user indicates they have nothing more to add, or the conversation has covered enough ground), thank them warmly and let them know they can end the call whenever they're ready — do not keep asking questions indefinitely.
- If the user's message is empty, garbled, or clearly not a real answer (this can happen if speech-to-text failed to pick anything up), politely ask them to repeat themselves — don't guess at what they said.`;

/**
 * Run one turn of the conversation: given the running message history (which
 * already includes the new user message), get the assistant's reply and any
 * patient-record updates it made along the way.
 *
 * @param {Array} messages - OpenAI chat message history for this session
 * @returns {Promise<{assistantText: string, recordUpdates: object[], messages: Array}>}
 */
export async function runConversationTurn(messages) {
  const workingMessages = [...messages];
  const recordUpdates = [];

  // Loop to handle the (rare but possible) case where the model wants to call
  // the tool more than once before producing its spoken reply.
  for (let i = 0; i < 3; i++) {
    const completion = await client.chat.completions.create({
      model: LLM_MODEL,
      messages: workingMessages,
      tools: [UPDATE_RECORD_TOOL],
      temperature: 0.6,
    });

    const choice = completion.choices[0];
    const msg = choice.message;
    workingMessages.push(msg);

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      return {
        assistantText: msg.content?.trim() || "Could you say that again?",
        recordUpdates,
        messages: workingMessages,
      };
    }

    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      recordUpdates.push(args);
      workingMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ status: "recorded" }),
      });
    }
    // Loop again so the model can now produce its actual spoken reply
    // after having "called" the tool.
  }

  // Fallback if the model somehow never stopped calling tools.
  return {
    assistantText: "Thanks for sharing that. Could you tell me more about how you're feeling?",
    recordUpdates,
    messages: workingMessages,
  };
}

export function buildInitialMessages() {
  return [{ role: "system", content: SYSTEM_PROMPT }];
}

/**
 * Synthesize the final structured report from the transcript + accumulated
 * patient record. Handles short/empty calls gracefully.
 */
export async function generateReport(transcript, patientRecord) {
  if (!transcript || transcript.length === 0) {
    return {
      summary: "The call ended before any information was exchanged.",
      chiefComplaint: null,
      duration: null,
      severity: null,
      otherSymptoms: [],
      followUp: ["No data was collected — recommend a follow-up call."],
      dataCompleteness: "none",
      rawTranscript: [],
    };
  }

  const transcriptText = transcript
    .map((t) => `${t.speaker === "ai" ? "Assistant" : "Patient"}: ${t.text}`)
    .join("\n");

  const reportSchema = {
    type: "object",
    properties: {
      summary: { type: "string", description: "2-3 sentence plain-language summary a doctor could glance at" },
      chiefComplaint: { type: ["string", "null"] },
      duration: { type: ["string", "null"] },
      severity: { type: ["string", "null"] },
      otherSymptoms: { type: "array", items: { type: "string" } },
      followUp: {
        type: "array",
        items: { type: "string" },
        description: "Things worth a clinician following up on, including if the call was cut short or answers were vague/contradictory",
      },
      dataCompleteness: {
        type: "string",
        enum: ["complete", "partial", "minimal", "none"],
        description: "How much of the standard intake was actually collected",
      },
    },
    required: ["summary", "otherSymptoms", "followUp", "dataCompleteness"],
  };

  try {
    const completion = await client.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You turn a messy spoken health-intake transcript into a structured clinical intake summary. Be concise and factual — only include what was actually said, never invent details. If information is missing, say so rather than guessing.",
        },
        {
          role: "user",
          content: `Structured data already extracted during the call:\n${JSON.stringify(
            patientRecord,
            null,
            2
          )}\n\nFull transcript:\n${transcriptText}\n\nProduce the structured report matching the given schema.`,
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "submit_report", description: "Submit the structured report", parameters: reportSchema },
        },
      ],
      tool_choice: { type: "function", function: { name: "submit_report" } },
    });

    const call = completion.choices[0].message.tool_calls?.[0];
    const parsed = call ? JSON.parse(call.function.arguments) : null;
    if (!parsed) throw new Error("no report returned");

    return {
      ...parsed,
      rawTranscript: transcript,
    };
  } catch (err) {
    console.error("[Report] generation failed, falling back to raw state:", err.message);
    // Graceful degradation: even if the synthesis call fails, return something
    // useful built directly from the structured record we already have.
    return {
      summary: "Automatic summary generation failed; showing collected data directly.",
      chiefComplaint: patientRecord.chiefComplaint,
      duration: patientRecord.durationDescription,
      severity: patientRecord.severity,
      otherSymptoms: patientRecord.otherSymptoms,
      followUp: patientRecord.notes.length ? patientRecord.notes : ["Report synthesis failed — review raw transcript."],
      dataCompleteness: patientRecord.chiefComplaint ? "partial" : "minimal",
      rawTranscript: transcript,
    };
  }
}
