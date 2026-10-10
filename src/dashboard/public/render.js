// Turns the dashboard's API data into HTML. Kept apart from index.html so the
// escaping can be tested in Node (src/dashboard/render.test.ts).
//
// Everything shown here can come from outside this machine: versions and
// method names are the model's reading of a third party's release notes, and
// errors can quote raw model output. So every value is escaped before it goes
// into innerHTML, and links must be https.

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function safeUrl(url) {
  return /^https:\/\//.test(url ?? "") ? esc(url) : "#";
}

function fmtTime(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString();
}

function badge(patch) {
  const file = esc(patch.filePath);
  if (patch.status === "pr_opened") {
    return `<a class="badge badge-ok" href="${safeUrl(patch.prUrl)}" target="_blank" rel="noopener">${file}: PR opened</a>`;
  }
  if (patch.status === "pr_exists") {
    return `<a class="badge badge-skip" href="${safeUrl(patch.prUrl)}" target="_blank" rel="noopener">${file}: PR from an earlier run</a>`;
  }
  if (patch.status === "no_change_needed") {
    return `<span class="badge badge-skip">${file}: no change needed</span>`;
  }
  return `<span class="badge badge-error" title="${esc(patch.error)}">${file}: error</span>`;
}

export function renderStatus(s) {
  return `
    <div><span>Last run</span>${esc(fmtTime(s.lastRunAt))}</div>
    <div><span>Last seen release</span>${esc(s.lastSeenTag ?? "none yet")}</div>
  `;
}

export function renderRuns(runs) {
  if (runs.length === 0) return '<div class="empty">No runs logged yet — run `npm run dev`.</div>';
  return `<table>
    <thead><tr><th>When</th><th>Changes found</th><th>Result</th></tr></thead>
    <tbody>
      ${runs.map((run) => `
        <tr>
          <td>${esc(fmtTime(run.startedAt))}${run.error ? `<br><span class="badge badge-error">run error: ${esc(run.error)}</span>` : ""}${
            (run.notesProblems ?? []).map((p) => `<br><span class="badge badge-error">notes problem: ${esc(p)}</span>`).join("")}</td>
          <td>${esc(run.changesFound)}</td>
          <td>
            ${run.changes.map((c) => `
              <div>
                <strong>${esc(c.version)}</strong> — ${c.fieldPath ? `field ${esc(c.fieldPath)}` : esc(c.methodName)} (${esc(c.usagesFound)} usage${c.usagesFound === 1 ? "" : "s"})
                ${c.error ? `<div class="badge badge-error">${esc(c.error)}</div>` : ""}
                <div>${c.patches.map(badge).join(" ")}</div>
              </div>
            `).join("")}
            ${(run.notPatched ?? []).map((n) => `<div><strong>${esc(n.version)}</strong> <span class="badge badge-skip">breaking, nothing to patch</span> ${esc(n.entry)}</div>`).join("")}
          </td>
        </tr>
      `).join("")}
    </tbody>
  </table>`;
}

export function renderEvals(evals) {
  if (evals.length === 0) return '<div class="empty">No eval runs yet — run `npm run eval`.</div>';
  return `<table>
    <thead><tr><th>Run</th><th>Result</th></tr></thead>
    <tbody>
      ${evals.map((e) => `
        <tr>
          <td>${esc(e.timestamp)}</td>
          <td><span class="badge ${e.passed === e.total ? "badge-ok" : "badge-error"}">${esc(e.passed)}/${esc(e.total)} passed</span></td>
        </tr>
      `).join("")}
    </tbody>
  </table>`;
}
