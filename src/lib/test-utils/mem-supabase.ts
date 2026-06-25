/**
 * Minimal in-memory Supabase double for tests.
 *
 * Supports the query shapes this codebase uses: insert / select / update /
 * delete / upsert with eq, in, is, not("col","in",...), gte, lt, order, limit,
 * and the maybeSingle / single / thenable terminals. Unknown tables are created
 * lazily as empty arrays so a flow can touch tables a test didn't seed.
 *
 * NOT a real database — no constraints, no RLS. Good enough to assert which rows
 * a service wrote and what it read back.
 */

export type Row = Record<string, unknown>;

interface Filter { op: string; c?: string; v?: unknown; opv?: string; asc?: boolean; n?: number }

function parseList(v: unknown): string[] {
  // e.g. ("approved","needs_correction")  →  ["approved","needs_correction"]
  return String(v).replace(/[()]/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  let out = [...rows];
  for (const f of filters) {
    switch (f.op) {
      case "eq":  out = out.filter((r) => r[f.c!] === f.v); break;
      case "is":  out = out.filter((r) => (r[f.c!] ?? null) === (f.v ?? null)); break;
      case "in":  out = out.filter((r) => (f.v as unknown[]).includes(r[f.c!])); break;
      case "not":
        if (f.opv === "in") {
          const list = parseList(f.v);
          out = out.filter((r) => !list.includes(String(r[f.c!])));
        }
        break;
      case "gte": out = out.filter((r) => String(r[f.c!]) >= String(f.v)); break;
      case "lt":  out = out.filter((r) => String(r[f.c!]) <  String(f.v)); break;
      case "order": {
        const asc = f.asc !== false;
        out = out.sort((a, b) => {
          const av = a[f.c!] as never, bv = b[f.c!] as never;
          if (av < bv) return asc ? -1 : 1;
          if (av > bv) return asc ?  1 : -1;
          return 0;
        });
        break;
      }
      case "limit": out = out.slice(0, f.n); break;
    }
  }
  return out;
}

export function memSupabase(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const k of Object.keys(seed)) tables[k] = seed[k].map((r) => ({ ...r }));
  let idSeq = 0;

  const table = (name: string): Row[] => (tables[name] ??= []);

  function selectChain(name: string, filters: Filter[]) {
    const rows = () => applyFilters(table(name), filters);
    const add  = (f: Filter) => selectChain(name, [...filters, f]);
    return {
      eq:    (c: string, v: unknown) => add({ op: "eq", c, v }),
      is:    (c: string, v: unknown) => add({ op: "is", c, v }),
      in:    (c: string, v: unknown[]) => add({ op: "in", c, v }),
      not:   (c: string, opv: string, v: unknown) => add({ op: "not", c, opv, v }),
      gte:   (c: string, v: unknown) => add({ op: "gte", c, v }),
      lt:    (c: string, v: unknown) => add({ op: "lt", c, v }),
      order: (c: string, o?: { ascending?: boolean }) => add({ op: "order", c, asc: o?.ascending !== false }),
      limit: (n: number) => add({ op: "limit", n }),
      async maybeSingle() { return { data: rows()[0] ?? null, error: null }; },
      async single() {
        const r = rows();
        return r.length ? { data: r[0], error: null } : { data: null, error: { message: "no rows", code: "PGRST116" } };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: rows(), error: null }));
      },
    };
  }

  function insert(name: string, payload: Row | Row[]) {
    const items = (Array.isArray(payload) ? payload : [payload]).map((p) => ({
      id: p.id ?? `${name}-${++idSeq}`,
      ...(name === "work_rounds" && p.status == null ? { status: "open" } : {}),
      ...p,
    }));
    table(name).push(...items);
    return {
      select() {
        return {
          async single()      { return { data: items[0] ?? null, error: null }; },
          async maybeSingle() { return { data: items[0] ?? null, error: null }; },
        };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: items, error: null }));
      },
    };
  }

  function mutateChain(name: string, filters: Filter[], mutate: (rows: Row[]) => Row[]) {
    const add = (f: Filter) => mutateChain(name, [...filters, f], mutate);
    const run = () => {
      const targets = applyFilters(table(name), filters);
      return mutate(targets);
    };
    return {
      eq:  (c: string, v: unknown) => add({ op: "eq", c, v }),
      is:  (c: string, v: unknown) => add({ op: "is", c, v }),
      in:  (c: string, v: unknown[]) => add({ op: "in", c, v }),
      lte: (c: string, v: unknown) => add({ op: "lt", c, v }), // lte≈lt for ISO strings here
      select() {
        return {
          async single()      { const r = run(); return { data: r[0] ?? null, error: r.length ? null : { message: "no rows" } }; },
          async maybeSingle() { const r = run(); return { data: r[0] ?? null, error: null }; },
        };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: run(), error: null }));
      },
    };
  }

  function upsert(name: string, payload: Row | Row[], opts?: { onConflict?: string }) {
    const items = Array.isArray(payload) ? payload : [payload];
    const keys  = opts?.onConflict?.split(",").map((s) => s.trim()) ?? [];
    for (const p of items) {
      let existing: Row | undefined;
      if (keys.length) existing = table(name).find((r) => keys.every((k) => r[k] === p[k]));
      if (existing) Object.assign(existing, p);
      else table(name).push({ id: p.id ?? `${name}-${++idSeq}`, ...p });
    }
    return {
      select() {
        return {
          async single()      { return { data: items[0] ?? null, error: null }; },
          async maybeSingle() { return { data: items[0] ?? null, error: null }; },
        };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: items as Row[], error: null }));
      },
    };
  }

  const client = {
    from(name: string) {
      return {
        select(_cols = "*") { return selectChain(name, []); },
        insert(payload: Row | Row[]) { return insert(name, payload); },
        upsert(payload: Row | Row[], opts?: { onConflict?: string }) { return upsert(name, payload, opts); },
        update(patch: Row) {
          return mutateChain(name, [], (rows) => {
            for (const r of rows) Object.assign(r, patch);
            return rows;
          });
        },
        delete() {
          return mutateChain(name, [], (rows) => {
            for (const r of rows) {
              const arr = table(name);
              const i = arr.indexOf(r);
              if (i >= 0) arr.splice(i, 1);
            }
            return rows;
          });
        },
      };
    },
    _tables: tables,
    _rows(name: string) { return tables[name] ?? []; },
  };

  return client;
}
