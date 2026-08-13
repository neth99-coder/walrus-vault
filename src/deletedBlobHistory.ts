/**
 * Reconstructs a wallet's deleted-Walrus-blob history from chain data.
 *
 * The public fullnode JSON-RPC endpoint (and its `queryTransactionBlocks`
 * method) has been deprecated, and the gRPC core API has no equivalent for
 * "list transactions sent by an address." The Sui GraphQL API still serves
 * this as a free, unauthenticated read, so this walks each transaction the
 * address sent and looks at its effects for objects that were deleted and
 * were (immediately before deletion) a Walrus `Blob` object.
 */

import { SuiGraphQLClient } from "@mysten/sui/graphql";

export type DeletedBlobTransaction = {
  digest: string;
  objectId: string;
  timestampMs: string | null;
};

const SENT_TRANSACTIONS_QUERY = `
  query SentTransactions($address: SuiAddress!, $after: String) {
    address(address: $address) {
      transactions(filter: { sentAddress: $address }, first: 50, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          digest
          effects {
            timestamp
            objectChanges(first: 50) {
              nodes {
                address
                idDeleted
                inputState {
                  asMoveObject {
                    contents {
                      type {
                        repr
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

type SentTransactionsQueryResult = {
  address: {
    transactions: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        digest: string;
        effects: {
          timestamp: string | null;
          objectChanges: {
            nodes: Array<{
              address: string;
              idDeleted: boolean;
              inputState: {
                asMoveObject: {
                  contents: { type: { repr: string } };
                } | null;
              } | null;
            }>;
          };
        } | null;
      }>;
    };
  } | null;
};

/**
 * Fetch every transaction the given address has sent (up to `maxPages`
 * pages) and return the Walrus `Blob` objects it deleted.
 */
export async function queryDeletedWalrusBlobTransactions(
  address: string,
  graphqlUrl: string,
  network: "testnet" | "mainnet" = "testnet",
  maxPages = 5,
): Promise<DeletedBlobTransaction[]> {
  const graphqlClient = new SuiGraphQLClient({
    url: graphqlUrl,
    network,
  });

  const entries: DeletedBlobTransaction[] = [];
  let after: string | null | undefined;
  let hasNextPage = true;
  let pages = 0;

  while (hasNextPage && pages < maxPages) {
    const result = await graphqlClient.query<SentTransactionsQueryResult>({
      query: SENT_TRANSACTIONS_QUERY,
      variables: { address, after },
    });

    if (result.errors?.length) {
      throw new Error(result.errors.map((error) => error.message).join("; "));
    }

    const transactions = result.data?.address?.transactions;

    if (!transactions) {
      break;
    }

    for (const tx of transactions.nodes) {
      const timestampMs = tx.effects?.timestamp
        ? String(new Date(tx.effects.timestamp).getTime())
        : null;

      for (const change of tx.effects?.objectChanges.nodes ?? []) {
        const typeRepr =
          change.inputState?.asMoveObject?.contents.type.repr ?? "";

        if (change.idDeleted && typeRepr.endsWith("::blob::Blob")) {
          entries.push({
            digest: tx.digest,
            objectId: change.address,
            timestampMs,
          });
        }
      }
    }

    after = transactions.pageInfo.endCursor;
    hasNextPage = transactions.pageInfo.hasNextPage;
    pages += 1;
  }

  return entries;
}
