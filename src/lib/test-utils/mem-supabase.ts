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
interface MemSupabaseOptions {
  rpcErrors?: Record<string, { message: string; code?: string }>;
  rpcBefore?: Record<string, (params: Row) => Promise<void>>;
}

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

export function memSupabase(seed: Record<string, Row[]> = {}, options: MemSupabaseOptions = {}) {
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
    const rawItems = Array.isArray(payload) ? payload : [payload];
    if (name === "raw_messages") {
      for (const p of rawItems) {
        if (table(name).some((r) => r.line_event_id === p.line_event_id)) {
          return {
            select() {
              return {
                async single() {
                  return {
                    data: null,
                    error: { code: "23505", message: "duplicate key value violates unique constraint" },
                  };
                },
              };
            },
          };
        }
      }
    }
    const items = rawItems.map((p) => ({
      id: p.id ?? `${name}-${++idSeq}`,
      ...(name === "work_rounds" && p.status == null ? { status: "open" } : {}),
      ...(p.created_at == null ? { created_at: new Date().toISOString() } : {}),
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

  function produceRoundEventConflict(existing: Row, incoming: Row): boolean {
    return (
      (existing.raw_message_id === incoming.raw_message_id &&
        existing.seq_in_message === incoming.seq_in_message) ||
      (existing.line_event_id === incoming.line_event_id &&
        existing.seq_in_message === incoming.seq_in_message)
    );
  }

  function insertProduceRoundEventsIgnore(events: unknown): Row[] {
    const items = Array.isArray(events) ? (events as Row[]) : [];
    const inserted: Row[] = [];
    for (const p of items) {
      const conflicting = table("produce_round_events").some((r) =>
        produceRoundEventConflict(r, p),
      );
      if (conflicting) continue;
      const newRow: Row = {
        id: p.id ?? `produce_round_events-${++idSeq}`,
        ...(p.created_at == null ? { created_at: new Date().toISOString() } : {}),
        ...p,
      };
      table("produce_round_events").push(newRow);
      inserted.push(newRow);
    }
    return inserted;
  }

  function upsert(
    name: string,
    payload: Row | Row[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) {
    const items = Array.isArray(payload) ? payload : [payload];
    const conflictKeys = opts?.onConflict?.split(",").map((s) => s.trim()) ?? [];

    const newRows: Row[] = [];
    for (const p of items) {
      const conflicting =
        conflictKeys.length > 0 &&
        table(name).some((r) => conflictKeys.every((k) => r[k] === p[k]));
      if (conflicting) {
        if (!opts?.ignoreDuplicates) {
          const existing = table(name).find((r) => conflictKeys.every((k) => r[k] === p[k]));
          if (existing) Object.assign(existing, p);
        }
      } else {
        const newRow: Row = {
          id: p.id ?? `${name}-${++idSeq}`,
          ...(p.created_at == null ? { created_at: new Date().toISOString() } : {}),
          ...(name === "pending_sessions" && p.session_generation == null
            ? { session_generation: crypto.randomUUID() }
            : {}),
          ...p,
        };
        table(name).push(newRow);
        newRows.push(newRow);
      }
    }
    return {
      select() {
        return {
          async single()      { return { data: newRows[0] ?? null, error: null }; },
          async maybeSingle() { return { data: newRows[0] ?? null, error: null }; },
          then(resolve: (v: { data: Row[]; error: null }) => unknown) {
            return Promise.resolve(resolve({ data: newRows, error: null }));
          },
        };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: newRows, error: null }));
      },
    };
  }

  function closeReadinessForSession(session: Row) {
    const sessionKey = String(session.session_key);
    const generation = session.session_generation;
    const closeTs = Number(session.close_event_timestamp_ms);
    const closeRequestedAt = String(session.close_requested_at);

    const admissions = table("pending_session_admission").filter(
      (row) =>
        row.session_key === sessionKey
        && row.session_generation === generation
        && Number(row.line_timestamp_ms) <= closeTs,
    );
    const ingests = table("pending_session_ingest").filter(
      (row) =>
        row.session_key === sessionKey
        && row.session_generation === generation
        && Number(row.line_timestamp_ms) <= closeTs
        && String(row.raw_text ?? "").trim() !== "",
    );
    const ingestedIds = new Set(ingests.map((row) => row.line_event_id));
    const stragglers = admissions.filter(
      (row) => String(row.admitted_at) > closeRequestedAt && !ingestedIds.has(row.line_event_id),
    );
    const nonEmptyLines = String(session.accumulated_text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const ledgerReady = admissions.length > 0
      && admissions.length === ingests.length
      && stragglers.length === 0;
    const legacyReady = !ledgerReady
      && admissions.length === 0
      && nonEmptyLines.length >= 3;
    const ready = ledgerReady || legacyReady;

    return {
      ready,
      reason: ready
        ? legacyReady ? "legacy_accumulated" : "ready"
        : admissions.length === 0
          ? "no_admissions"
          : stragglers.length > 0
            ? "stragglers"
            : "awaiting_ingest",
      admission_count: admissions.length,
      ingest_count: ingests.length,
      straggler_count: stragglers.length,
    };
  }

  const client = {
    async rpc(name: string, params: Row = {}) {
      const forcedError = options.rpcErrors?.[name];
      if (forcedError) return { data: null, error: forcedError };

      if (name === "admit_pending_session_event") {
        const sessionKey = params.p_session_key as string;
        const session = table("pending_sessions").find((row) => row.session_key === sessionKey);
        if (!session) return { data: null, error: null };
        const exists = table("pending_session_admission").some(
          (row) =>
            row.session_generation === session.session_generation
            && row.line_event_id === params.p_line_event_id,
        );
        if (!exists) {
          table("pending_session_admission").push({
            session_key: sessionKey,
            session_generation: session.session_generation,
            line_event_id: params.p_line_event_id,
            line_timestamp_ms: params.p_line_timestamp_ms,
            admitted_at: new Date().toISOString(),
          });
        }
        return { data: null, error: null };
      }

      if (name === "append_pending_session") {
        await options.rpcBefore?.[name]?.(params);
        const sessionKey = params.p_session_key;
        const current = table("pending_sessions").find((row) => row.session_key === sessionKey);
        if (!current) {
          return { data: null, error: { message: `pending session not found for append: ${String(sessionKey)}` } };
        }
        current.accumulated_text = `${String(current.accumulated_text)}\n${String(params.p_new_text ?? "")}`;
        current.latest_reply_token = params.p_reply_token ?? null;
        current.updated_at = new Date().toISOString();
        if (params.p_mark_close) {
          current.close_event_timestamp_ms = params.p_line_timestamp_ms ?? null;
          current.close_requested_at = new Date().toISOString();
          current.close_line_event_id = params.p_line_event_id ?? null;
        }
        if (params.p_line_event_id != null && params.p_line_timestamp_ms != null) {
          const existing = table("pending_session_ingest").find(
            (row) =>
              row.session_generation === current.session_generation
              && row.line_event_id === params.p_line_event_id,
          );
          if (existing) {
            existing.line_timestamp_ms = params.p_line_timestamp_ms;
            existing.raw_text = params.p_new_text ?? existing.raw_text ?? null;
          } else {
            table("pending_session_ingest").push({
              session_key: sessionKey,
              session_generation: current.session_generation,
              line_event_id: params.p_line_event_id,
              line_timestamp_ms: params.p_line_timestamp_ms,
              raw_text: params.p_new_text ?? null,
              created_at: new Date().toISOString(),
            });
          }
        }
        return { data: current, error: null };
      }

      if (name === "register_pending_session_ingest") {
        const session = table("pending_sessions").find(
          (row) => row.session_key === params.p_session_key,
        );
        if (!session || params.p_raw_text == null) return { data: null, error: null };
        const existing = table("pending_session_ingest").find(
          (row) =>
            row.session_generation === session.session_generation
            && row.line_event_id === params.p_line_event_id,
        );
        if (existing) {
          existing.line_timestamp_ms = params.p_line_timestamp_ms;
          existing.raw_text = params.p_raw_text ?? existing.raw_text ?? null;
        } else {
          table("pending_session_ingest").push({
            session_key: params.p_session_key,
            session_generation: session.session_generation,
            line_event_id: params.p_line_event_id,
            line_timestamp_ms: params.p_line_timestamp_ms,
            raw_text: params.p_raw_text ?? null,
            created_at: new Date().toISOString(),
          });
        }
        return { data: null, error: null };
      }

      if (name === "check_pending_close_ready") {
        const sessionKey = params.p_session_key as string;
        const session = table("pending_sessions").find((row) => row.session_key === sessionKey);
        if (!session?.close_event_timestamp_ms || !session.close_requested_at) {
          return { data: { ready: false, reason: "not_closing" }, error: null };
        }
        return { data: closeReadinessForSession(session), error: null };
      }

      if (name === "claim_pending_close_finalize") {
        const sessionKey = params.p_session_key as string;
        const session = table("pending_sessions").find((row) => row.session_key === sessionKey);
        if (!session) {
          return { data: { claimed: false, reason: "gone" }, error: null };
        }
        if (!session.close_event_timestamp_ms || !session.close_requested_at) {
          return { data: { claimed: false, reason: "not_closing" }, error: null };
        }
        if (session.close_finalize_started_at) {
          return { data: { claimed: false, reason: "already_claimed" }, error: null };
        }

        const readiness = closeReadinessForSession(session);
        if (!readiness.ready) {
          return {
            data: { claimed: false, reason: readiness.reason, ...readiness },
            error: null,
          };
        }

        session.close_finalize_started_at = new Date().toISOString();
        return {
          data: {
            claimed: true,
            session,
            admission_count: readiness.admission_count,
            ingest_count: readiness.ingest_count,
          },
          error: null,
        };
      }

      if (name === "insert_produce_round_events_ignore") {
        const inserted = insertProduceRoundEventsIgnore(params.events);
        return { data: inserted, error: null };
      }

      return {
        data: null,
        error: {
          code:    "PGRST202",
          message: `Could not find the function ${name}`,
        },
      };
    },
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
