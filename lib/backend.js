/** What a successful probe contributes to a saved channel. Absent fields are omitted, never null. */
export function backendOf(report) {
  const out = { family: report.backend?.family ?? 'unknown', modelCount: report.models?.count ?? 0, checkedAt: Date.now() };
  if (report.backend?.name) out.name = String(report.backend.name).slice(0, 120);
  if (report.backend?.version) out.version = String(report.backend.version).slice(0, 60);
  if (report.quota?.kind) out.quotaKind = report.quota.kind;
  // Kept so a later render has a name even before the site is identified again.
  if (report.backend?.title) out.title = String(report.backend.title).slice(0, 80);
  return out;
}
