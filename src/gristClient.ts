/**
 * Thin wrapper around the data-room-server API, which proxies to the Grist
 * Records API on the backend (see ../../data-room-server/src/grist.ts).
 *
 * The frontend used to call Grist directly, but that both shipped the Grist
 * API key in the browser bundle and hit Grist's CORS policy. Routing through
 * our own backend fixes both: the key stays server-side, and the backend
 * sets CORS headers for this app's origin.
 */

export type GristRecord<TFields> = {
  id: number;
  fields: TFields;
};

type GristFilter = Record<string, Array<string | number | boolean>>;

function getServerBaseUrl() {
  const baseUrl = import.meta.env.VITE_DATA_ROOM_SERVER_URL;

  if (!baseUrl) {
    throw new Error(
      "Data room server is not configured. Set VITE_DATA_ROOM_SERVER_URL.",
    );
  }

  return baseUrl;
}

async function serverRequest<TResponse>(
  path: string,
  options?: RequestInit,
): Promise<TResponse> {
  const baseUrl = getServerBaseUrl();

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `data-room-server ${options?.method ?? "GET"} ${path} failed (${response.status}): ${body}`,
    );
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  return (await response.json()) as TResponse;
}

/** List records from a table, optionally filtered (AND across columns, OR within a column's value list). */
export async function listGristRecords<TFields extends object>(
  table: string,
  filter?: GristFilter,
): Promise<GristRecord<TFields>[]> {
  const query = filter
    ? `?filter=${encodeURIComponent(JSON.stringify(filter))}`
    : "";

  const result = await serverRequest<{ records: GristRecord<TFields>[] }>(
    `/api/tables/${table}/records${query}`,
  );

  return result.records;
}

/**
 * Add-or-update records, matched by the `require` fields (natural key).
 * A record with no existing match matching `require` is inserted with
 * `require` merged into `fields`; an existing match is updated in place.
 */
export async function upsertGristRecords<TFields extends object>(
  table: string,
  records: Array<{ require: Partial<TFields>; fields: TFields }>,
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  await serverRequest(`/api/tables/${table}/records`, {
    method: "PUT",
    body: JSON.stringify({ records }),
  });
}

/** Delete records by row id. */
export async function deleteGristRecords(
  table: string,
  rowIds: number[],
): Promise<void> {
  if (rowIds.length === 0) {
    return;
  }

  await serverRequest(`/api/tables/${table}/delete`, {
    method: "POST",
    body: JSON.stringify(rowIds),
  });
}
