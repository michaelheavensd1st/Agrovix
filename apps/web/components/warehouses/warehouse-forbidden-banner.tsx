/**
 * Sprint 5.2 — scoped forbidden banner for warehouse UI. Mirrors
 * the Sprint 5.1 workspace pattern: the banner carries a
 * `data-testid` per scope so tests can assert the affected slice
 * without inspecting the message string.
 */
export function WarehouseForbiddenBanner({
  scope,
  message,
}: {
  scope: 'org' | 'warehouse' | 'activity';
  message: string;
}) {
  return (
    <div
      className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center"
      data-testid={`warehouse-forbidden-${scope}`}
    >
      <p className="font-display text-lg">You don&apos;t have access.</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
