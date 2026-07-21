/**
 * Sprint 5.3 — scoped forbidden banner. One `data-testid` per
 * scope so tests can assert affected slice.
 */
export function InventoryItemForbiddenBanner({
  scope,
  message,
}: {
  scope: 'org' | 'item' | 'availability' | 'activity';
  message: string;
}) {
  return (
    <div
      className="rounded-2xl border border-dashed border-border bg-card/40 p-10 text-center"
      data-testid={`item-forbidden-${scope}`}
    >
      <p className="font-display text-lg">You don&apos;t have access.</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
