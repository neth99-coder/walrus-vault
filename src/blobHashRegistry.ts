/**
 * On-chain blob hash registry utilities.
 *
 * Uploaders call `buildRegisterHashTransaction` and submit it with their
 * wallet — a `HashRegistered` event is emitted on-chain.
 *
 * Verifiers (no wallet required) call `queryAllBlobHashes` which pages
 * through all `HashRegistered` events via the Sui GraphQL API. Public
 * fullnode JSON-RPC has been deprecated, so event queries can no longer
 * go through `SuiJsonRpcClient` — GraphQL is the supported free-read path.
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiGraphQLClient } from "@mysten/sui/graphql";

export const BLOB_HASH_MODULE = "blob_hash_registry";
export const REGISTER_HASH_FUNCTION = "register_hash";

export type HashEntry = {
  blobId: string;
  objectId: string;
  sha256Hex: string;
  fileName: string;
  uploader: string;
  timestampMs: string | null;
};

// ---------------------------------------------------------------------------
// Write (requires connected wallet)
// ---------------------------------------------------------------------------

/**
 * Build a `Transaction` that registers a SHA-256 hash on-chain by emitting
 * a `HashRegistered` event.  Pass the returned transaction to
 * `signAndExecuteTransaction`.
 */
export function buildRegisterHashTransaction(
  packageId: string,
  blobId: string,
  objectId: string,
  sha256Hex: string,
  fileName: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::${BLOB_HASH_MODULE}::${REGISTER_HASH_FUNCTION}`,
    arguments: [
      tx.pure.string(blobId),
      tx.pure.string(objectId),
      tx.pure.string(sha256Hex),
      tx.pure.string(fileName),
    ],
  });
  return tx;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

type RawParsedJson = {
  blob_id?: unknown;
  object_id?: unknown;
  sha256_hex?: unknown;
  file_name?: unknown;
  uploader?: unknown;
};

function parseHashEntry(
  parsedJson: unknown,
  sender: string,
  timestampMs: string | null | undefined,
): HashEntry | null {
  if (!parsedJson || typeof parsedJson !== "object") {
    return null;
  }

  const raw = parsedJson as RawParsedJson;

  if (
    typeof raw.blob_id !== "string" ||
    typeof raw.object_id !== "string" ||
    typeof raw.sha256_hex !== "string" ||
    typeof raw.file_name !== "string" ||
    typeof raw.uploader !== "string"
  ) {
    return null;
  }

  return {
    blobId: raw.blob_id,
    objectId: raw.object_id,
    sha256Hex: raw.sha256_hex,
    fileName: raw.file_name,
    uploader: raw.uploader || sender,
    timestampMs: timestampMs ?? null,
  };
}

const EVENTS_QUERY = `
  query BlobHashEvents($type: String!, $after: String) {
    events(filter: { type: $type }, first: 50, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        sender {
          address
        }
        timestamp
        contents {
          json
        }
      }
    }
  }
`;

type EventsQueryResult = {
  events: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      sender: { address: string } | null;
      timestamp: string | null;
      contents: { json: unknown } | null;
    }>;
  };
};

/**
 * Fetch every `HashRegistered` event for the given package from the Sui
 * network and return them as `HashEntry` records. Reads go through the Sui
 * GraphQL API (`graphqlUrl`) since it is a free, unauthenticated read path
 * that (unlike the deprecated public JSON-RPC endpoint) is still served.
 */
export async function queryAllBlobHashes(
  packageId: string,
  graphqlUrl: string,
  network: "testnet" | "mainnet" = "testnet",
): Promise<HashEntry[]> {
  const graphqlClient = new SuiGraphQLClient({
    url: graphqlUrl,
    network,
  });

  const eventType = `${packageId}::${BLOB_HASH_MODULE}::HashRegistered`;
  const entries: HashEntry[] = [];
  let after: string | null | undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const result = await graphqlClient.query<EventsQueryResult>({
      query: EVENTS_QUERY,
      variables: { type: eventType, after },
    });

    if (result.errors?.length) {
      throw new Error(result.errors.map((error) => error.message).join("; "));
    }

    const events = result.data?.events;

    if (!events) {
      break;
    }

    for (const event of events.nodes) {
      const sender = event.sender?.address ?? "";
      const timestampMs = event.timestamp
        ? String(new Date(event.timestamp).getTime())
        : null;

      const entry = parseHashEntry(event.contents?.json, sender, timestampMs);
      if (entry) {
        entries.push(entry);
      }
    }

    after = events.pageInfo.endCursor;
    hasNextPage = events.pageInfo.hasNextPage;
  }

  return entries;
}
