const completenessLabel = {
  complete: "Complete",
  partial: "Partial",
  minimal: "Minimal",
  none: "No data collected",
};

export default function ReportView({ report, onRestart }) {
  if (!report) return null;

  return (
    <div className="report-screen">
      <div className="report-header">
        <h1>Health Screening Report</h1>
        <span className={`badge badge-${report.dataCompleteness}`}>
          {completenessLabel[report.dataCompleteness] || report.dataCompleteness}
        </span>
      </div>

      <section className="report-section">
        <h2>Summary</h2>
        <p>{report.summary}</p>
      </section>

      <section className="report-grid">
        <div>
          <h3>Chief Complaint</h3>
          <p>{report.chiefComplaint || "Not reported"}</p>
        </div>
        <div>
          <h3>Duration</h3>
          <p>{report.duration || "Not reported"}</p>
        </div>
        <div>
          <h3>Severity</h3>
          <p>{report.severity || "Not reported"}</p>
        </div>
      </section>

      <section className="report-section">
        <h3>Other Symptoms</h3>
        {report.otherSymptoms?.length ? (
          <ul>
            {report.otherSymptoms.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">None reported</p>
        )}
      </section>

      <section className="report-section">
        <h3>Flagged for Follow-Up</h3>
        {report.followUp?.length ? (
          <ul className="follow-up">
            {report.followUp.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing flagged</p>
        )}
      </section>

      <details className="raw-transcript">
        <summary>View raw transcript</summary>
        <div className="transcript static">
          {report.rawTranscript?.map((turn, i) => (
            <div key={i} className={`bubble ${turn.speaker}`}>
              <span className="bubble-label">{turn.speaker === "ai" ? "Assistant" : "Patient"}</span>
              <p>{turn.text}</p>
            </div>
          ))}
        </div>
      </details>

      <button className="btn btn-primary" onClick={onRestart}>
        Start a New Call
      </button>
    </div>
  );
}
