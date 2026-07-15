'use client';

/**
 * Sprint 4 — Inventory workspace.
 *
 * One deliberate operator screen covering every workflow the spec
 * calls for: warehouses, items, lots + balances, receive / issue /
 * transfer / adjust / reverse, and per-lot transaction history.
 *
 * We do NOT auto-scaffold generic CRUD screens for other resource
 * types — those live under later bounded contexts.
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';

// --- Types ---------------------------------------------------------- //
interface Organization {
  id: string;
  name: string;
  slug: string;
}
interface Warehouse {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'closed';
  farm_id: string | null;
}
interface InventoryItem {
  id: string;
  code: string;
  name: string;
  category: 'feed' | 'medicine' | 'chemical' | 'supply';
  canonical_unit: string;
}
interface Lot {
  id: string;
  item_id: string;
  warehouse_id: string;
  lot_code: string;
  expiry_date: string | null;
  balance: string;
  balance_unit: string;
}
interface LedgerTx {
  id: string;
  transaction_type: string;
  quantity: string;
  unit: string;
  performed_at: string;
  reason: string | null;
  reference_type: string | null;
}

type Tab =
  | 'overview'
  | 'warehouses'
  | 'items'
  | 'lots'
  | 'receive'
  | 'issue'
  | 'transfer'
  | 'adjust'
  | 'history';

function idem(prefix: string) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

async function postWithKey<T>(path: string, body: unknown, key: string): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

function friendly(err: unknown): string {
  if (err instanceof ApiError) {
    const d = err.payload?.detail;
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object' && 'message' in d) return (d as { message: string }).message;
    return `${err.status} ${err.message}`;
  }
  return String(err);
}

// -------------------------------------------------------------------- //
export default function InventoryPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) ?? 'overview');
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgId, setOrgId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [selectedWh, setSelectedWh] = useState<string>('');
  const [lots, setLots] = useState<Lot[]>([]);
  const [history, setHistory] = useState<LedgerTx[]>([]);
  const [selectedLot, setSelectedLot] = useState<string>('');

  // Bootstrap: load orgs.
  useEffect(() => {
    (async () => {
      try {
        const list = await apiFetch<Organization[]>('/v1/organizations');
        setOrgs(list);
        if (list.length > 0) setOrgId(list[0].id);
        else router.push('/onboarding');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) router.push('/login');
        else setError(friendly(e));
      }
    })();
  }, [router]);

  const reloadOrg = useCallback(async () => {
    if (!orgId) return;
    try {
      const [wh, it] = await Promise.all([
        apiFetch<Warehouse[]>(`/v1/organizations/${orgId}/warehouses`),
        apiFetch<InventoryItem[]>(`/v1/organizations/${orgId}/inventory-items`),
      ]);
      setWarehouses(wh);
      setItems(it);
      if (wh.length > 0 && !selectedWh) setSelectedWh(wh[0].id);
    } catch (e) {
      setError(friendly(e));
    }
  }, [orgId, selectedWh]);

  const reloadLots = useCallback(async () => {
    if (!selectedWh) return;
    try {
      const list = await apiFetch<Lot[]>(`/v1/warehouses/${selectedWh}/lots`);
      setLots(list);
    } catch (e) {
      setError(friendly(e));
    }
  }, [selectedWh]);

  useEffect(() => {
    void reloadOrg();
  }, [reloadOrg]);
  useEffect(() => {
    void reloadLots();
  }, [reloadLots]);

  useEffect(() => {
    if (selectedLot) {
      apiFetch<{ items: LedgerTx[] }>(`/v1/lots/${selectedLot}/transactions`)
        .then((r) => setHistory(r.items))
        .catch((e) => setError(friendly(e)));
    }
  }, [selectedLot]);

  const totalBalanceByItem = useMemo(() => {
    const acc = new Map<string, { balance: number; unit: string; name: string }>();
    for (const lot of lots) {
      const item = items.find((i) => i.id === lot.item_id);
      const name = item?.name ?? lot.item_id;
      const prev = acc.get(name) ?? { balance: 0, unit: lot.balance_unit, name };
      prev.balance += Number(lot.balance);
      acc.set(name, prev);
    }
    return Array.from(acc.values());
  }, [items, lots]);

  const currentWh = warehouses.find((w) => w.id === selectedWh) ?? null;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'warehouses', label: 'Warehouses' },
    { key: 'items', label: 'Items' },
    { key: 'lots', label: 'Lots & balances' },
    { key: 'receive', label: 'Receive stock' },
    { key: 'issue', label: 'Issue stock' },
    { key: 'transfer', label: 'Transfer stock' },
    { key: 'adjust', label: 'Adjust / reconcile' },
    { key: 'history', label: 'Transaction history' },
  ];

  return (
    <main className="mx-auto max-w-6xl px-6 py-10" data-testid="inventory-page">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            Sprint 4 · Operational Resources
          </p>
          <h1 className="font-display text-3xl">Inventory</h1>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted-foreground">Organization</label>
          <select
            data-testid="inv-org-selector"
            className="rounded-md border border-border bg-background px-2 py-1"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div
          data-testid="inv-error"
          className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <nav
        className="mb-6 flex flex-wrap gap-2 border-b border-border pb-2"
        data-testid="inv-tabs"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            data-testid={`inv-tab-${t.key}`}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === t.key
                ? 'bg-primary text-primary-foreground'
                : 'border border-border hover:bg-secondary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <section data-testid="inv-overview" className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-border p-4">
            <p className="text-xs text-muted-foreground">Warehouses</p>
            <p className="font-display text-2xl">{warehouses.length}</p>
          </div>
          <div className="rounded-2xl border border-border p-4">
            <p className="text-xs text-muted-foreground">Items</p>
            <p className="font-display text-2xl">{items.length}</p>
          </div>
          <div className="rounded-2xl border border-border p-4">
            <p className="text-xs text-muted-foreground">Lots</p>
            <p className="font-display text-2xl">{lots.length}</p>
          </div>
          {totalBalanceByItem.length > 0 && (
            <div className="col-span-full rounded-2xl border border-border p-4">
              <p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">
                Balances (canonical units)
              </p>
              <ul className="grid gap-1 text-sm sm:grid-cols-2">
                {totalBalanceByItem.map((row) => (
                  <li key={row.name} className="flex justify-between border-b border-border py-1">
                    <span>{row.name}</span>
                    <span className="font-mono">
                      {row.balance} {row.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {tab === 'warehouses' && (
        <WarehousesPanel
          orgId={orgId}
          warehouses={warehouses}
          onChange={reloadOrg}
          onSelect={(id) => {
            setSelectedWh(id);
            setTab('lots');
          }}
        />
      )}

      {tab === 'items' && (
        <ItemsPanel orgId={orgId} items={items} onChange={reloadOrg} />
      )}

      {tab === 'lots' && (
        <LotsPanel
          warehouses={warehouses}
          selectedWh={selectedWh}
          onSelectWh={setSelectedWh}
          lots={lots}
          items={items}
          onOpenLot={(id) => {
            setSelectedLot(id);
            setTab('history');
          }}
        />
      )}

      {tab === 'receive' && (
        <ReceivePanel
          warehouses={warehouses}
          items={items}
          selectedWh={selectedWh}
          onSelectWh={setSelectedWh}
          onDone={reloadLots}
        />
      )}

      {tab === 'issue' && (
        <TxPanel
          mode="issue"
          warehouse={currentWh}
          lots={lots}
          items={items}
          onDone={reloadLots}
        />
      )}

      {tab === 'transfer' && (
        <TransferPanel
          warehouses={warehouses}
          warehouse={currentWh}
          lots={lots}
          items={items}
          onDone={reloadLots}
        />
      )}

      {tab === 'adjust' && (
        <TxPanel
          mode="adjust"
          warehouse={currentWh}
          lots={lots}
          items={items}
          onDone={reloadLots}
        />
      )}

      {tab === 'history' && (
        <HistoryPanel
          lots={lots}
          selectedLot={selectedLot}
          onSelect={setSelectedLot}
          history={history}
        />
      )}
    </main>
  );
}

// -------------------------------------------------------------------- //
// Sub-panels
// -------------------------------------------------------------------- //
function WarehousesPanel({
  orgId,
  warehouses,
  onChange,
  onSelect,
}: {
  orgId: string;
  warehouses: Warehouse[];
  onChange: () => void;
  onSelect: (id: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/v1/organizations/${orgId}/warehouses`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), code: code.trim() }),
      });
      setName('');
      setCode('');
      setCreating(false);
      onChange();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="inv-warehouses">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg">Warehouses</h2>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1 text-sm hover:bg-secondary"
          data-testid="inv-warehouse-new"
          onClick={() => setCreating((v) => !v)}
        >
          {creating ? 'Cancel' : '+ New warehouse'}
        </button>
      </div>
      {creating && (
        <form onSubmit={submit} className="mb-4 grid gap-2 rounded-md border border-border p-3 sm:grid-cols-3">
          <input
            data-testid="inv-warehouse-name"
            placeholder="Name"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            data-testid="inv-warehouse-code"
            placeholder="Code (unique per org)"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          <button
            type="submit"
            disabled={busy}
            data-testid="inv-warehouse-submit"
            className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Create'}
          </button>
          {err && <p className="col-span-full text-sm text-destructive">{err}</p>}
        </form>
      )}
      <ul className="divide-y divide-border rounded-md border border-border">
        {warehouses.map((w) => (
          <li key={w.id} className="flex items-center justify-between p-3">
            <div>
              <p className="font-medium">{w.name}</p>
              <p className="text-xs text-muted-foreground">
                {w.code} · {w.status}
                {w.farm_id ? ' · farm-pinned' : ' · org-shared'}
              </p>
            </div>
            <button
              type="button"
              data-testid={`inv-warehouse-open-${w.code}`}
              className="rounded-md border border-border px-3 py-1 text-xs hover:bg-secondary"
              onClick={() => onSelect(w.id)}
            >
              Open lots →
            </button>
          </li>
        ))}
        {warehouses.length === 0 && (
          <li className="p-4 text-sm text-muted-foreground">No warehouses yet.</li>
        )}
      </ul>
    </section>
  );
}

function ItemsPanel({
  orgId,
  items,
  onChange,
}: {
  orgId: string;
  items: InventoryItem[];
  onChange: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    code: '',
    name: '',
    category: 'feed' as 'feed' | 'medicine' | 'chemical' | 'supply',
    canonical_unit: 'kg' as string,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiFetch(`/v1/organizations/${orgId}/inventory-items`, {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm({ code: '', name: '', category: 'feed', canonical_unit: 'kg' });
      setCreating(false);
      onChange();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="inv-items">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg">Catalog items</h2>
        <button
          type="button"
          data-testid="inv-item-new"
          className="rounded-md border border-border px-3 py-1 text-sm hover:bg-secondary"
          onClick={() => setCreating((v) => !v)}
        >
          {creating ? 'Cancel' : '+ New item'}
        </button>
      </div>
      {creating && (
        <form onSubmit={submit} className="mb-4 grid gap-2 rounded-md border border-border p-3 sm:grid-cols-4">
          <input
            data-testid="inv-item-code"
            placeholder="Code"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            required
          />
          <input
            data-testid="inv-item-name"
            placeholder="Name"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <select
            data-testid="inv-item-category"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as typeof form.category })}
          >
            {(['feed', 'medicine', 'chemical', 'supply'] as const).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            data-testid="inv-item-unit"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={form.canonical_unit}
            onChange={(e) => setForm({ ...form, canonical_unit: e.target.value })}
          >
            {['kg', 'g', 'L', 'mL', 'count', 'bag', 'pack'].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy}
            data-testid="inv-item-submit"
            className="col-span-full rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {busy ? 'Saving…' : 'Create item'}
          </button>
          {err && <p className="col-span-full text-sm text-destructive">{err}</p>}
        </form>
      )}
      <ul className="divide-y divide-border rounded-md border border-border">
        {items.map((it) => (
          <li key={it.id} className="p-3">
            <p className="font-medium">
              {it.name} <span className="text-xs text-muted-foreground">({it.code})</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {it.category} · canonical unit {it.canonical_unit}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">{it.id}</p>
          </li>
        ))}
        {items.length === 0 && <li className="p-4 text-sm text-muted-foreground">No items yet.</li>}
      </ul>
    </section>
  );
}

function LotsPanel({
  warehouses,
  selectedWh,
  onSelectWh,
  lots,
  items,
  onOpenLot,
}: {
  warehouses: Warehouse[];
  selectedWh: string;
  onSelectWh: (id: string) => void;
  lots: Lot[];
  items: InventoryItem[];
  onOpenLot: (id: string) => void;
}) {
  return (
    <section data-testid="inv-lots">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg">Lots &amp; balances</h2>
        <select
          data-testid="inv-lots-warehouse"
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          value={selectedWh}
          onChange={(e) => onSelectWh(e.target.value)}
        >
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Lot</th>
              <th className="px-3 py-2 text-left">Item</th>
              <th className="px-3 py-2 text-left">Expiry</th>
              <th className="px-3 py-2 text-right">Balance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lots.map((lot) => {
              const item = items.find((i) => i.id === lot.item_id);
              return (
                <tr key={lot.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono">{lot.lot_code}</td>
                  <td className="px-3 py-2">{item?.name ?? lot.item_id}</td>
                  <td className="px-3 py-2">{lot.expiry_date ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {lot.balance} {lot.balance_unit}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      data-testid={`inv-lot-open-${lot.lot_code}`}
                      className="text-xs text-primary hover:underline"
                      onClick={() => onOpenLot(lot.id)}
                    >
                      History →
                    </button>
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {lot.id}
                    </div>
                  </td>
                </tr>
              );
            })}
            {lots.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  No lots. Receive stock to create one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReceivePanel({
  warehouses,
  items,
  selectedWh,
  onSelectWh,
  onDone,
}: {
  warehouses: Warehouse[];
  items: InventoryItem[];
  selectedWh: string;
  onSelectWh: (id: string) => void;
  onDone: () => void;
}) {
  const [itemId, setItemId] = useState('');
  const [lotCode, setLotCode] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('kg');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await postWithKey(
        `/v1/warehouses/${selectedWh}/inventory:receive`,
        {
          item_id: itemId,
          lot_code: lotCode.trim(),
          quantity: Number(qty),
          unit,
        },
        idem('receipt'),
      );
      setOk('Stock received.');
      setLotCode('');
      setQty('');
      onDone();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-2"
      data-testid="inv-receive-form"
    >
      <label className="block text-sm">
        Warehouse
        <select
          data-testid="inv-receive-warehouse"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
          value={selectedWh}
          onChange={(e) => onSelectWh(e.target.value)}
        >
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Item
        <select
          data-testid="inv-receive-item"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
          required
        >
          <option value="">— select —</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.canonical_unit})
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Lot code
        <input
          data-testid="inv-receive-lot-code"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
          value={lotCode}
          onChange={(e) => setLotCode(e.target.value)}
          required
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          Quantity
          <input
            data-testid="inv-receive-quantity"
            type="number"
            step="0.001"
            min="0.001"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          Unit
          <select
            data-testid="inv-receive-unit"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          >
            {['kg', 'g', 'L', 'mL', 'count', 'bag', 'pack'].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>
      {err && <p className="col-span-full text-sm text-destructive">{err}</p>}
      {ok && (
        <p className="col-span-full text-sm text-emerald-600" data-testid="inv-receive-ok">
          {ok}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !selectedWh || !itemId}
        data-testid="inv-receive-submit"
        className="col-span-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {busy ? 'Posting…' : 'Post receipt'}
      </button>
    </form>
  );
}

function TxPanel({
  mode,
  warehouse,
  lots,
  items,
  onDone,
}: {
  mode: 'issue' | 'adjust';
  warehouse: Warehouse | null;
  lots: Lot[];
  items: InventoryItem[];
  onDone: () => void;
}) {
  const [lotId, setLotId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('kg');
  const [direction, setDirection] = useState<'increase' | 'decrease'>('decrease');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!warehouse) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      if (mode === 'issue') {
        await postWithKey(
          `/v1/warehouses/${warehouse.id}/inventory:issue`,
          { lot_id: lotId, quantity: Number(qty), unit, reason: reason || undefined },
          idem('issue'),
        );
      } else {
        await postWithKey(
          `/v1/warehouses/${warehouse.id}/inventory:adjust`,
          { lot_id: lotId, quantity: Number(qty), unit, direction, reason },
          idem('adjust'),
        );
      }
      setOk('Posted.');
      onDone();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-2"
      data-testid={`inv-${mode}-form`}
    >
      <label className="block text-sm">
        Lot
        <select
          data-testid={`inv-${mode}-lot`}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
          value={lotId}
          onChange={(e) => setLotId(e.target.value)}
          required
        >
          <option value="">— select —</option>
          {lots.map((lot) => {
            const item = items.find((i) => i.id === lot.item_id);
            return (
              <option key={lot.id} value={lot.id}>
                {lot.lot_code} · {item?.name} · {lot.balance} {lot.balance_unit}
              </option>
            );
          })}
        </select>
      </label>
      {mode === 'adjust' && (
        <label className="block text-sm">
          Direction
          <select
            data-testid="inv-adjust-direction"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'increase' | 'decrease')}
          >
            <option value="decrease">Decrease</option>
            <option value="increase">Increase</option>
          </select>
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          Quantity
          <input
            data-testid={`inv-${mode}-qty`}
            type="number"
            step="0.001"
            min="0.001"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          Unit
          <select
            data-testid={`inv-${mode}-unit`}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          >
            {['kg', 'g', 'L', 'mL', 'count', 'bag', 'pack'].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="col-span-full block text-sm">
        Reason {mode === 'adjust' ? '(required)' : '(optional)'}
        <textarea
          data-testid={`inv-${mode}-reason`}
          rows={2}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required={mode === 'adjust'}
        />
      </label>
      {err && <p className="col-span-full text-sm text-destructive">{err}</p>}
      {ok && (
        <p className="col-span-full text-sm text-emerald-600" data-testid={`inv-${mode}-ok`}>
          {ok}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !warehouse || !lotId}
        data-testid={`inv-${mode}-submit`}
        className="col-span-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {busy ? 'Posting…' : mode === 'issue' ? 'Post issue' : 'Post adjustment'}
      </button>
    </form>
  );
}

function TransferPanel({
  warehouses,
  warehouse,
  lots,
  items,
  onDone,
}: {
  warehouses: Warehouse[];
  warehouse: Warehouse | null;
  lots: Lot[];
  items: InventoryItem[];
  onDone: () => void;
}) {
  const [lotId, setLotId] = useState('');
  const [dstWh, setDstWh] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('kg');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!warehouse) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await postWithKey(
        `/v1/warehouses/${warehouse.id}/inventory:transfer`,
        {
          lot_id: lotId,
          destination_warehouse_id: dstWh,
          quantity: Number(qty),
          unit,
        },
        idem('transfer'),
      );
      setOk('Transferred.');
      onDone();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-2"
      data-testid="inv-transfer-form"
    >
      <label className="block text-sm">
        Source lot
        <select
          data-testid="inv-transfer-lot"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
          value={lotId}
          onChange={(e) => setLotId(e.target.value)}
          required
        >
          <option value="">— select —</option>
          {lots.map((lot) => {
            const item = items.find((i) => i.id === lot.item_id);
            return (
              <option key={lot.id} value={lot.id}>
                {lot.lot_code} · {item?.name} · {lot.balance} {lot.balance_unit}
              </option>
            );
          })}
        </select>
      </label>
      <label className="block text-sm">
        Destination warehouse
        <select
          data-testid="inv-transfer-destination"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
          value={dstWh}
          onChange={(e) => setDstWh(e.target.value)}
          required
        >
          <option value="">— select —</option>
          {warehouses
            .filter((w) => w.id !== warehouse?.id)
            .map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          Quantity
          <input
            data-testid="inv-transfer-qty"
            type="number"
            step="0.001"
            min="0.001"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
          />
        </label>
        <label className="block text-sm">
          Unit
          <select
            data-testid="inv-transfer-unit"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          >
            {['kg', 'g', 'L', 'mL', 'count', 'bag', 'pack'].map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>
      {err && <p className="col-span-full text-sm text-destructive">{err}</p>}
      {ok && (
        <p className="col-span-full text-sm text-emerald-600" data-testid="inv-transfer-ok">
          {ok}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !warehouse || !lotId || !dstWh}
        data-testid="inv-transfer-submit"
        className="col-span-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {busy ? 'Posting…' : 'Post transfer'}
      </button>
    </form>
  );
}

function HistoryPanel({
  lots,
  selectedLot,
  onSelect,
  history,
}: {
  lots: Lot[];
  selectedLot: string;
  onSelect: (id: string) => void;
  history: LedgerTx[];
}) {
  return (
    <section data-testid="inv-history">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg">Transaction history</h2>
        <select
          data-testid="inv-history-lot"
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          value={selectedLot}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="">— pick a lot —</option>
          {lots.map((lot) => (
            <option key={lot.id} value={lot.id}>
              {lot.lot_code}
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-xs uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-left">Ref</th>
            </tr>
          </thead>
          <tbody>
            {history.map((tx) => (
              <tr key={tx.id} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-xs">{tx.performed_at}</td>
                <td className="px-3 py-2">{tx.transaction_type}</td>
                <td className="px-3 py-2 text-right font-mono">
                  {tx.quantity} {tx.unit}
                </td>
                <td className="px-3 py-2">{tx.reason ?? '—'}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {tx.reference_type ?? ''}
                </td>
              </tr>
            ))}
            {selectedLot && history.length === 0 && (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  No transactions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
