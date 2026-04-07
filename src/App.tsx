import { useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  useCurrentAccount,
  useCurrentClient,
  useCurrentNetwork,
  useDAppKit,
  useWallets,
} from "@mysten/dapp-kit-react";
import { isEnokiWallet, isGoogleWallet } from "@mysten/enoki";

import "./App.css";
import {
  createWalrusBlobAttributes,
  formatBlobLabel,
  formatBytes,
  getMaxPublicUploadBytes,
  getRawWalrusBlobObject,
  getWalrusAggregatorUrl,
  getWalrusClient,
  getWalrusContentType,
  getWalrusDownloadUrl,
  getWalrusFileName,
  getWalrusPublisherUrl,
  getWalrusUploadedAt,
  normalizeBlobId,
  type WalrusBlobRecord,
} from "./walrus";

type BalanceRow = {
  balance: string;
  coinType: string;
  decimals: number;
  name: string;
  symbol: string;
};

type UploadFeedback =
  | {
      blobId: string;
      kind: "already-certified";
      storedUntilEpoch: number;
      txDigest: string | null;
    }
  | {
      blobId: string;
      kind: "newly-created";
      objectId: string;
      storedUntilEpoch: number;
    };

type UploadResponse = {
  alreadyCertified?: {
    blobId: string;
    endEpoch: number;
    event?: {
      eventSeq: string;
      txDigest: string;
    };
  };
  newlyCreated?: {
    blobObject: {
      blobId: string;
      id: string;
      storage: {
        endEpoch: number;
      };
    };
  };
};

type DeletedBlobRecord = {
  blobId: string | null;
  contentType: string | null;
  deletable: boolean | null;
  digest: string | null;
  fileName: string | null;
  objectId: string;
  size: string | null;
  storedUntilEpoch: number | null;
  timestampMs: string | null;
  uploadedAt: string | null;
};

type DeletedHistoryArgument =
  | "GasCoin"
  | { Input: number }
  | { Result: number }
  | { NestedResult: [number, number] };

type DeletedHistoryTransaction = {
  digest: string;
  timestampMs?: string | null;
  transaction?: {
    data?: {
      transaction?: {
        kind?: string;
        inputs?: Array<{ objectId?: string; type?: string }>;
        transactions?: Array<{
          MoveCall?: {
            arguments?: DeletedHistoryArgument[];
            function: string;
            module: string;
          };
        }>;
      };
    };
  };
};

const isConfigured = Boolean(
  import.meta.env.VITE_ENOKI_API_KEY && import.meta.env.VITE_GOOGLE_CLIENT_ID,
);

const walrusPublisherUrl = getWalrusPublisherUrl();
const walrusAggregatorUrl = getWalrusAggregatorUrl();
const maxUploadBytes = getMaxPublicUploadBytes();
const JSON_RPC_URLS = {
  testnet: "https://fullnode.testnet.sui.io:443",
} as const;

function App() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const currentNetwork = useCurrentNetwork();
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadEpochs, setUploadEpochs] = useState("1");
  const [isUploadDeletable, setIsUploadDeletable] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<UploadFeedback | null>(
    null,
  );
  const [fileActionError, setFileActionError] = useState<string | null>(null);
  const [deletingObjectId, setDeletingObjectId] = useState<string | null>(null);
  const [filesTab, setFilesTab] = useState<"active" | "expired" | "deleted">(
    "active",
  );
  const [hiddenDeletedObjectIds, setHiddenDeletedObjectIds] = useState<
    string[]
  >([]);
  const [deletedSnapshots, setDeletedSnapshots] = useState<
    Record<string, DeletedBlobRecord>
  >({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyResetTimeoutRef = useRef<number | null>(null);

  const walrusClient = useMemo(() => getWalrusClient(client), [client]);
  const historyClient = useMemo(() => {
    const network = currentNetwork as keyof typeof JSON_RPC_URLS;
    const url = JSON_RPC_URLS[network];

    if (!url) {
      return null;
    }

    return new SuiJsonRpcClient({ network, url });
  }, [currentNetwork]);

  const googleWallet = useMemo(
    () => wallets.filter(isEnokiWallet).find(isGoogleWallet) ?? null,
    [wallets],
  );

  const balancesQuery = useQuery({
    queryKey: ["balances", currentNetwork, account?.address],
    enabled: Boolean(account),
    queryFn: async (): Promise<BalanceRow[]> => {
      if (!account) {
        return [];
      }

      const { balances } = await client.listBalances({
        owner: account.address,
      });

      const rows = await Promise.all(
        balances.map(async (balance) => {
          const metadataResponse = await client
            .getCoinMetadata({ coinType: balance.coinType })
            .catch(() => ({ coinMetadata: null }));

          const metadata = metadataResponse.coinMetadata;
          const fallbackSymbol = balance.coinType.split("::").at(-1) ?? "TOKEN";

          return {
            balance: balance.balance,
            coinType: balance.coinType,
            decimals: metadata?.decimals ?? 0,
            name: metadata?.name ?? fallbackSymbol,
            symbol: metadata?.symbol ?? fallbackSymbol,
          };
        }),
      );

      return rows.sort((left, right) =>
        Number(BigInt(right.balance) - BigInt(left.balance)),
      );
    },
  });

  const walrusFilesQuery = useQuery({
    queryKey: ["walrus-files", currentNetwork, account?.address],
    enabled: Boolean(account),
    queryFn: async (): Promise<WalrusBlobRecord[]> => {
      if (!account) {
        return [];
      }

      const blobType = await walrusClient.walrus.getBlobType();
      const ownedObjectIds: string[] = [];
      let cursor: string | null = null;
      let hasNextPage = true;

      while (hasNextPage) {
        const listResponse: {
          cursor: string | null;
          hasNextPage: boolean;
          objects: Array<{ objectId: string }>;
        } = await client.listOwnedObjects({
          owner: account.address,
          type: blobType,
          cursor,
          limit: 100,
        });

        ownedObjectIds.push(
          ...listResponse.objects.map((object) => object.objectId),
        );
        cursor = listResponse.cursor;
        hasNextPage = listResponse.hasNextPage;
      }

      const rows: Array<WalrusBlobRecord | null> = await Promise.all(
        ownedObjectIds.map(async (objectId) => {
          try {
            let blobObject: {
              blob_id: string;
              certified_epoch: number | null;
              deletable: boolean;
              id: string;
              registered_epoch: number;
              size: string;
              storage: { end_epoch: number };
            } | null = null;

            try {
              blobObject = await walrusClient.walrus.getBlobObject(objectId);
            } catch (getBlobError) {
              console.warn(
                "[walrus] getBlobObject failed for",
                objectId,
                getBlobError,
              );
              try {
                const { object } = await client.getObject({
                  objectId,
                  include: { display: true, json: true },
                });
                const rawBlobObject = getRawWalrusBlobObject(object);

                if (!rawBlobObject) {
                  console.warn(
                    "[walrus] getRawWalrusBlobObject returned null for",
                    objectId,
                    "— skipping",
                  );
                  return null;
                }

                blobObject = {
                  blob_id: rawBlobObject.blobId,
                  certified_epoch: rawBlobObject.certifiedEpoch,
                  deletable: rawBlobObject.deletable,
                  id: rawBlobObject.objectId,
                  registered_epoch: rawBlobObject.registeredEpoch,
                  size: rawBlobObject.size,
                  storage: {
                    end_epoch: rawBlobObject.storedUntilEpoch,
                  },
                };
              } catch (getObjectError) {
                console.warn(
                  "[walrus] getObject fallback also failed for",
                  objectId,
                  getObjectError,
                  "— skipping",
                );
                return null;
              }
            }

            let attributes: Record<string, string> | null = null;

            try {
              attributes = await walrusClient.walrus.readBlobAttributes({
                blobObjectId: objectId,
              });
            } catch {
              attributes = null;
            }

            const normalizedBlobId = normalizeBlobId(blobObject.blob_id);

            const fileName =
              getWalrusFileName(attributes) ??
              formatBlobLabel(normalizedBlobId);
            const contentType = getWalrusContentType(attributes);
            const uploadedAt = getWalrusUploadedAt(attributes);

            return {
              blobId: normalizedBlobId,
              certifiedEpoch: blobObject.certified_epoch,
              contentType,
              deletable: blobObject.deletable,
              downloadUrl: getWalrusDownloadUrl(normalizedBlobId),
              fileName,
              objectId: blobObject.id,
              registeredEpoch: blobObject.registered_epoch,
              size: blobObject.size,
              storedUntilEpoch: blobObject.storage.end_epoch,
              uploadedAt,
            } satisfies WalrusBlobRecord;
          } catch (error) {
            // Any unexpected error for a single object should not kill the whole list
            console.warn(
              "[walrus] unexpected error loading object",
              objectId,
              error,
              "— skipping",
            );
            return null;
          }
        }),
      );

      return rows
        .filter((row): row is WalrusBlobRecord => row !== null)
        .sort((left, right) => Number(BigInt(right.size) - BigInt(left.size)));
    },
  });

  async function handleGoogleLogin() {
    if (!googleWallet) {
      return;
    }

    setLoginError(null);
    setIsSigningIn(true);

    try {
      const result = await dAppKit.connectWallet({ wallet: googleWallet });

      if (!result.accounts.length) {
        setLoginError(
          "Google sign-in finished, but no wallet account was returned. Check the Enoki allow list and your Google redirect URI configuration.",
        );
      }
    } catch (error) {
      setLoginError(formatLoginError(error));
    } finally {
      setIsSigningIn(false);
    }
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    setUploadError(null);
    setUploadFeedback(null);
    setUploadFile(event.target.files?.[0] ?? null);
  }

  async function delay(milliseconds: number) {
    await new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function reloadPageAfterUploadSuccess() {
    await delay(900);
    window.location.reload();
  }

  async function refreshWalrusFilesUntilVisible(objectId: string) {
    console.log(
      "[walrus] refreshWalrusFilesUntilVisible: waiting for objectId",
      objectId,
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await walrusFilesQuery.refetch();
      const foundIds = result.data?.map((f) => f.objectId) ?? [];
      console.log(
        `[walrus] attempt ${attempt + 1}: owned blob objectIds =`,
        foundIds,
      );

      if (result.data?.some((file) => file.objectId === objectId)) {
        console.log("[walrus] objectId found in list, done.");
        return;
      }

      if (attempt < 3) {
        console.log(`[walrus] objectId not found yet, retrying in 1200ms...`);
        await delay(1200);
      }
    }
    console.warn(
      "[walrus] objectId never appeared after 4 attempts:",
      objectId,
    );
  }

  async function refreshWalrusFilesUntilDeleted(objectId: string) {
    console.log(
      "[walrus] refreshWalrusFilesUntilDeleted: waiting for objectId removal",
      objectId,
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await walrusFilesQuery.refetch();
      const stillExists =
        result.data?.some((file) => file.objectId === objectId) ?? false;

      console.log(
        `[walrus] delete attempt ${attempt + 1}: object still present =`,
        stillExists,
      );

      if (!stillExists) {
        setHiddenDeletedObjectIds((current) =>
          current.filter((id) => id !== objectId),
        );
        return;
      }

      if (attempt < 3) {
        await delay(1200);
      }
    }
  }

  async function persistWalrusMetadataOnSui(
    objectId: string,
    file: File,
  ): Promise<void> {
    console.log(
      "[walrus] persistWalrusMetadataOnSui: writing attributes for objectId",
      objectId,
    );
    try {
      const transaction = new Transaction();

      // Avoid the SDK's internal readBlobAttributes(blobObjectId) pre-read here.
      // For a fresh upload we want to write against the just-created blob object
      // reference directly, otherwise a stale metadata dynamic-field lookup can
      // fail the transaction build before signing.
      await walrusClient.walrus.writeBlobAttributesTransaction({
        transaction,
        blobObject: transaction.object(objectId),
        attributes: createWalrusBlobAttributes(file),
      });

      const txResult = await dAppKit.signAndExecuteTransaction({ transaction });
      console.log(
        "[walrus] signAndExecuteTransaction result:",
        JSON.stringify(txResult, null, 2),
      );
    } catch (error) {
      // Attribute writing is best-effort. If it fails (e.g. a stale attributes
      // object from a previous attempt references a consumed object), log and
      // continue — the blob is already stored on Walrus.
      console.warn(
        "[walrus] writeBlobAttributesTransaction failed (non-fatal):",
        error,
      );
    }
  }

  async function handleWalrusUpload() {
    if (!account || !uploadFile) {
      return;
    }

    if (uploadFile.size > maxUploadBytes) {
      setUploadError(
        `Public Walrus publishers usually cap uploads at ${formatBytes(String(maxUploadBytes))}. Choose a smaller file or run your own publisher.`,
      );
      return;
    }

    const epochs = Number(uploadEpochs);

    if (!Number.isInteger(epochs) || epochs < 1) {
      setUploadError(
        "Epochs must be a whole number greater than or equal to 1.",
      );
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    setUploadFeedback(null);

    try {
      const searchParams = new URLSearchParams({
        epochs: String(epochs),
        send_object_to: account.address,
      });

      if (isUploadDeletable) {
        searchParams.set("deletable", "true");
      } else {
        searchParams.set("permanent", "true");
      }

      const response = await fetch(
        `${walrusPublisherUrl}/v1/blobs?${searchParams.toString()}`,
        {
          method: "PUT",
          body: uploadFile,
        },
      );

      console.log("[walrus] upload response:", response);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          errorText || `Upload failed with status ${response.status}`,
        );
      }

      const payload = (await response.json()) as UploadResponse;
      console.log("[walrus] upload payload:", payload);

      const newlyCreatedBlob = payload.newlyCreated?.blobObject;
      const alreadyCertifiedBlob = payload.alreadyCertified;
      const newObjectId = newlyCreatedBlob?.id;

      if (newlyCreatedBlob && newObjectId) {
        console.log(
          "[walrus] publisher returned newlyCreated objectId:",
          newObjectId,
          "blobId:",
          newlyCreatedBlob.blobId,
        );

        await persistWalrusMetadataOnSui(newObjectId, uploadFile);

        setUploadFeedback({
          blobId: newlyCreatedBlob.blobId,
          kind: "newly-created",
          objectId: newObjectId,
          storedUntilEpoch: newlyCreatedBlob.storage.endEpoch,
        });

        await refreshWalrusFilesUntilVisible(newObjectId);
      } else {
        await walrusFilesQuery.refetch();
      }

      if (alreadyCertifiedBlob) {
        setUploadFeedback({
          blobId: alreadyCertifiedBlob.blobId,
          kind: "already-certified",
          storedUntilEpoch: alreadyCertifiedBlob.endEpoch,
          txDigest: alreadyCertifiedBlob.event?.txDigest ?? null,
        });
      }

      setUploadFile(null);
      setUploadEpochs("1");
      await reloadPageAfterUploadSuccess();
    } catch (error) {
      console.error("Upload error:", error);
      setUploadError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  function formatLoginError(error: unknown) {
    if (!(error instanceof Error)) {
      return "Unknown login error";
    }

    const clientError = error as Error & {
      code?: string;
      status?: number;
      cause?: unknown;
      errors?: Array<{ code?: string; message?: string }>;
    };

    const detail =
      clientError.errors?.[0]?.message ??
      (clientError.cause instanceof Error ? clientError.cause.message : null);

    const code = clientError.errors?.[0]?.code ?? clientError.code;

    if (detail && code) {
      return `${error.message} [${code}] ${detail}`;
    }

    if (detail) {
      return `${error.message}: ${detail}`;
    }

    return error.message;
  }
  async function handleLogout() {
    setLoginError(null);
    await dAppKit.disconnectWallet();
  }

  async function handleDownload(
    url: string,
    fileName: string,
    contentType: string | null,
  ) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const headerMime =
      contentType ?? response.headers.get("content-type") ?? null;
    // If stored type is generic/absent, sniff the actual bytes
    const mimeType =
      !headerMime || headerMime === "application/octet-stream"
        ? (sniffMimeType(arrayBuffer) ??
          headerMime ??
          "application/octet-stream")
        : headerMime;
    const blob = new Blob([arrayBuffer], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = ensureExtension(fileName, mimeType);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objectUrl);
  }

  async function handleDelete(file: WalrusBlobRecord) {
    if (!account || !file.deletable || deletingObjectId) {
      return;
    }

    const confirmed = window.confirm(
      `Delete ${getDisplayFileName(file)}? This removes the Walrus blob object from your wallet.`,
    );

    if (!confirmed) {
      return;
    }

    setFileActionError(null);
    setDeletingObjectId(file.objectId);

    try {
      const transaction = walrusClient.walrus.deleteBlobTransaction({
        blobObjectId: file.objectId,
        owner: account.address,
      });

      await dAppKit.signAndExecuteTransaction({ transaction });

      setDeletedSnapshots((current) => ({
        ...current,
        [file.objectId]: {
          blobId: file.blobId,
          contentType: file.contentType,
          deletable: file.deletable,
          digest: null,
          fileName: file.fileName,
          objectId: file.objectId,
          size: file.size,
          storedUntilEpoch: file.storedUntilEpoch,
          timestampMs: String(Date.now()),
          uploadedAt: file.uploadedAt,
        },
      }));

      setHiddenDeletedObjectIds((current) =>
        current.includes(file.objectId) ? current : [...current, file.objectId],
      );

      if (
        uploadFeedback?.kind === "newly-created" &&
        uploadFeedback.objectId === file.objectId
      ) {
        setUploadFeedback(null);
      }

      await refreshWalrusFilesUntilDeleted(file.objectId);
      await deletedFilesQuery.refetch();
    } catch (error) {
      console.error("Delete error:", error);
      setHiddenDeletedObjectIds((current) =>
        current.filter((id) => id !== file.objectId),
      );
      setFileActionError(
        error instanceof Error ? error.message : "Failed to delete file",
      );
    } finally {
      setDeletingObjectId(null);
    }
  }

  const walrusEpochQuery = useQuery({
    queryKey: ["walrus-epoch", currentNetwork],
    enabled: Boolean(account),
    queryFn: async (): Promise<number> => {
      const state = await walrusClient.walrus.stakingState();
      return state.epoch;
    },
  });

  const deletedFilesQuery = useQuery({
    queryKey: ["deleted-files", currentNetwork, account?.address],
    enabled: Boolean(account && historyClient),
    queryFn: async (): Promise<DeletedBlobRecord[]> => {
      if (!account || !historyClient) {
        return [];
      }

      const response = await historyClient.queryTransactionBlocks({
        filter: { FromAddress: account.address },
        limit: 100,
        options: { showInput: true },
        order: "descending",
      });

      const records = new Map<string, DeletedBlobRecord>();

      for (const tx of response.data as DeletedHistoryTransaction[]) {
        for (const objectId of extractDeletedBlobObjectIds(tx)) {
          if (!records.has(objectId)) {
            records.set(objectId, {
              blobId: null,
              contentType: null,
              deletable: true,
              digest: tx.digest,
              fileName: null,
              objectId,
              size: null,
              storedUntilEpoch: null,
              timestampMs: tx.timestampMs ?? null,
              uploadedAt: null,
            });
          }
        }
      }

      return Array.from(records.values());
    },
  });

  const currentEpoch = walrusEpochQuery.data ?? null;
  const allFiles = (walrusFilesQuery.data ?? []).filter(
    (file) => !hiddenDeletedObjectIds.includes(file.objectId),
  );
  const deletedFiles = mergeDeletedBlobRecords(
    deletedFilesQuery.data ?? [],
    Object.values(deletedSnapshots),
  );
  const activeFiles =
    currentEpoch !== null
      ? allFiles.filter((f) => f.storedUntilEpoch >= currentEpoch)
      : allFiles;
  const expiredFiles =
    currentEpoch !== null
      ? allFiles.filter((f) => f.storedUntilEpoch < currentEpoch)
      : [];
  const totalFiles = allFiles.length;
  const totalAssets = balancesQuery.data?.length ?? 0;
  const activeCount = activeFiles.length;
  const expiredCount = expiredFiles.length;
  const deletedCount = deletedFiles.length;

  async function copyTextToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }

  async function handleCopy(copyKey: string, text: string) {
    try {
      await copyTextToClipboard(text);
      setCopiedKey(copyKey);

      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }

      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedKey(null);
      }, 1200);
    } catch (error) {
      console.warn("[copy] failed to copy text", error);
    }
  }

  return (
    <div className="app-root">
      {/* Top navigation */}
      <nav className="topnav">
        <div className="topnav-brand">
          <span className="brand-mark" aria-hidden="true">
            ◈
          </span>
          <span className="brand-name">Walrus Vault</span>
        </div>
        <div className="topnav-right">
          <span className="badge-network">{currentNetwork}</span>
          {account ? (
            <>
              <div className="copy-inline-group">
                <span className="topnav-address mono">
                  {shortenAddress(account.address)}
                </span>
                <button
                  className="copy-value-btn"
                  onClick={() =>
                    void handleCopy("wallet-topnav", account.address)
                  }
                  title="Copy wallet address"
                  type="button"
                >
                  {copiedKey === "wallet-topnav" ? "Copied" : "Copy"}
                </button>
              </div>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => void handleLogout()}
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </nav>

      {/* Not configured warning */}
      {!isConfigured ? (
        <div className="page-content">
          <div className="alert alert-warning">
            <strong>Missing environment variables</strong>
            <p>
              Add <code>VITE_ENOKI_API_KEY</code> and{" "}
              <code>VITE_GOOGLE_CLIENT_ID</code> in <code>.env</code>.
            </p>
          </div>
        </div>
      ) : null}

      {/* Login page */}
      {isConfigured && !account ? (
        <div className="login-page">
          <div className="login-card">
            <div className="login-mark" aria-hidden="true">
              ◈
            </div>
            <h1 className="login-title">Walrus Vault</h1>
            <p className="login-sub">
              Decentralized file storage on Sui&rsquo;s Walrus protocol
            </p>
            <button
              className="btn btn-black btn-large btn-google"
              disabled={!googleWallet || !isConfigured || isSigningIn}
              onClick={() => void handleGoogleLogin()}
            >
              <span className="google-mark" aria-hidden="true">
                G
              </span>
              {isSigningIn ? "Signing in\u2026" : "Continue with Google"}
            </button>
            {!googleWallet && isConfigured ? (
              <p className="hint-text">Registering wallet provider\u2026</p>
            ) : null}
            {loginError ? <p className="feedback-error">{loginError}</p> : null}
          </div>
        </div>
      ) : null}

      {/* Dashboard */}
      {account ? (
        <div className="page-content">
          {/* Address bar */}
          <div className="address-bar">
            <div className="address-bar-left">
              <span className="address-bar-label">Wallet</span>
              <div className="copy-inline-group copy-inline-group-wide">
                <span className="address-bar-value mono break">
                  {account.address}
                </span>
                <button
                  className="copy-value-btn"
                  onClick={() => void handleCopy("wallet-bar", account.address)}
                  title="Copy wallet address"
                  type="button"
                >
                  {copiedKey === "wallet-bar" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div className="address-bar-stats">
              <div className="stat-item">
                <span className="stat-num">{totalFiles}</span>
                <span className="stat-lbl">files</span>
              </div>
              <div className="stat-sep" />
              <div className="stat-item">
                <span className="stat-num">{totalAssets}</span>
                <span className="stat-lbl">assets</span>
              </div>
            </div>
          </div>

          {/* Workspace */}
          <div className="workspace">
            {/* Left sidebar: upload + assets */}
            <div className="workspace-side">
              {/* Upload */}
              <section className="card">
                <div className="card-header">
                  <h2>Upload</h2>
                </div>
                <div className="upload-form">
                  <div className="form-field">
                    <label className="field-label" htmlFor="walrus-file-input">
                      File
                    </label>
                    <input
                      id="walrus-file-input"
                      className="file-input-native"
                      type="file"
                      onChange={handleFileSelection}
                    />
                    <label
                      className="file-picker-btn"
                      htmlFor="walrus-file-input"
                    >
                      {uploadFile ? "Choose another file" : "Choose file"}
                    </label>
                  </div>

                  {uploadFile ? (
                    <div className="selected-file">
                      <span className="selected-name mono">
                        {uploadFile.name}
                      </span>
                      <span className="selected-size">
                        {formatBytes(String(uploadFile.size))}
                      </span>
                    </div>
                  ) : null}

                  <div className="form-row">
                    <div className="form-field">
                      <label
                        className="field-label"
                        htmlFor="walrus-epochs-input"
                      >
                        Epochs
                        <span
                          className="info-tip"
                          aria-label={`One epoch is ~24 hours on Walrus. Your file stays stored for this many epochs from now.${
                            currentEpoch !== null
                              ? ` Current epoch: ${currentEpoch}.`
                              : ""
                          } E.g. entering 5 stores it for ~5 days.`}
                        >
                          ⓘ
                        </span>
                      </label>
                      <input
                        id="walrus-epochs-input"
                        className="text-input"
                        inputMode="numeric"
                        min="1"
                        step="1"
                        value={uploadEpochs}
                        onChange={(event) =>
                          setUploadEpochs(event.target.value)
                        }
                      />
                    </div>
                    <label
                      className="toggle-field"
                      htmlFor="walrus-deletable-toggle"
                    >
                      <input
                        id="walrus-deletable-toggle"
                        type="checkbox"
                        checked={isUploadDeletable}
                        onChange={(event) =>
                          setIsUploadDeletable(event.target.checked)
                        }
                      />
                      <span>Deletable</span>
                    </label>
                  </div>

                  <button
                    className="btn btn-black"
                    disabled={!uploadFile || isUploading}
                    onClick={() => void handleWalrusUpload()}
                  >
                    {isUploading ? "Uploading\u2026" : "Upload to Walrus"}
                  </button>

                  {uploadError ? (
                    <p className="feedback-error">{uploadError}</p>
                  ) : null}

                  {uploadFeedback?.kind === "newly-created" ? (
                    <p className="feedback-success">
                      Uploaded. Object{" "}
                      <span className="mono">
                        {shortenObjectId(uploadFeedback.objectId)}
                      </span>{" "}
                      stored until epoch {uploadFeedback.storedUntilEpoch}.
                    </p>
                  ) : null}

                  {uploadFeedback?.kind === "already-certified" ? (
                    <p className="feedback-info">
                      Already stored. Blob{" "}
                      <span className="mono">
                        {shortenBlobId(uploadFeedback.blobId)}
                      </span>{" "}
                      until epoch {uploadFeedback.storedUntilEpoch}.
                    </p>
                  ) : null}
                </div>

                <div className="endpoints">
                  <div className="endpoint-row">
                    <span className="endpoint-label">Publisher</span>
                    <span className="endpoint-url mono">
                      {walrusPublisherUrl}
                    </span>
                  </div>
                  <div className="endpoint-row">
                    <span className="endpoint-label">Aggregator</span>
                    <span className="endpoint-url mono">
                      {walrusAggregatorUrl}
                    </span>
                  </div>
                  <p className="hint-text">
                    Max {formatBytes(String(maxUploadBytes))} per file
                  </p>
                </div>
              </section>

              {/* Assets */}
              <section className="card">
                <div className="card-header">
                  <h2>
                    Assets
                    {totalAssets > 0 ? (
                      <span className="count-badge">{totalAssets}</span>
                    ) : null}
                  </h2>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => void balancesQuery.refetch()}
                    title="Refresh balances"
                  >
                    ↻ Refresh
                  </button>
                </div>

                {balancesQuery.isPending ? (
                  <p className="state-text">Loading\u2026</p>
                ) : null}

                {balancesQuery.isError ? (
                  <p className="state-text state-error">
                    {(balancesQuery.error as Error).message}
                  </p>
                ) : null}

                {!balancesQuery.isPending && !balancesQuery.isError ? (
                  balancesQuery.data && balancesQuery.data.length > 0 ? (
                    <div className="asset-list">
                      {balancesQuery.data.map((balance) => (
                        <article className="asset-row" key={balance.coinType}>
                          <div className="asset-row-name">
                            <span className="asset-symbol">
                              {balance.symbol}
                            </span>
                            <span className="asset-coin-type mono break">
                              {balance.coinType}
                            </span>
                          </div>
                          <span className="asset-amount mono">
                            {formatBalance(balance.balance, balance.decimals)}
                          </span>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="state-text">No assets on {currentNetwork}.</p>
                  )
                ) : null}
              </section>
            </div>

            {/* Files panel */}
            <section className="card files-panel">
              <div className="card-header">
                <h2>
                  {filesTab === "active"
                    ? "Active"
                    : filesTab === "expired"
                      ? "Expired"
                      : "Deleted"}
                  <span className="count-badge">
                    {filesTab === "active"
                      ? activeCount
                      : filesTab === "expired"
                        ? expiredCount
                        : deletedCount}
                  </span>
                </h2>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    void walrusFilesQuery.refetch();
                    void deletedFilesQuery.refetch();
                  }}
                >
                  ↻ Refresh
                </button>
              </div>

              <div className="panel-tabs">
                <button
                  className={`panel-tab ${filesTab === "active" ? "panel-tab-active" : ""}`}
                  onClick={() => setFilesTab("active")}
                  type="button"
                >
                  Active
                </button>
                <button
                  className={`panel-tab ${filesTab === "expired" ? "panel-tab-active" : ""}`}
                  onClick={() => setFilesTab("expired")}
                  type="button"
                >
                  Expired
                </button>
                <button
                  className={`panel-tab ${filesTab === "deleted" ? "panel-tab-active" : ""}`}
                  onClick={() => setFilesTab("deleted")}
                  type="button"
                >
                  Deleted
                </button>
              </div>

              {(filesTab === "active" || filesTab === "expired") &&
              walrusFilesQuery.isPending ? (
                <p className="state-text">Loading files\u2026</p>
              ) : null}

              {(filesTab === "active" || filesTab === "expired") &&
              walrusFilesQuery.isError ? (
                <p className="state-text state-error">
                  {(walrusFilesQuery.error as Error).message}
                </p>
              ) : null}

              {filesTab === "deleted" && deletedFilesQuery.isPending ? (
                <p className="state-text">Loading deleted history\u2026</p>
              ) : null}

              {filesTab === "deleted" && deletedFilesQuery.isError ? (
                <p className="state-text state-error">
                  {(deletedFilesQuery.error as Error).message}
                </p>
              ) : null}

              {fileActionError ? (
                <p className="state-text state-error">{fileActionError}</p>
              ) : null}

              {filesTab === "active" &&
              !walrusFilesQuery.isPending &&
              !walrusFilesQuery.isError ? (
                activeFiles.length > 0 ? (
                  <div className="file-list">
                    {activeFiles.map((file) => (
                      <article className="file-row" key={file.objectId}>
                        <div className="file-row-info">
                          <span className="file-name">
                            {getDisplayFileName(file)}
                          </span>
                          <div className="file-id-row mono">
                            <button
                              className="file-id copy-id-btn"
                              onClick={() =>
                                void handleCopy(
                                  `object-${file.objectId}`,
                                  file.objectId,
                                )
                              }
                              title="Copy object ID"
                              type="button"
                            >
                              Object {shortenObjectId(file.objectId)}
                              <span className="copy-status">
                                {copiedKey === `object-${file.objectId}`
                                  ? "Copied"
                                  : "Copy"}
                              </span>
                            </button>
                            <button
                              className="file-id copy-id-btn"
                              onClick={() =>
                                void handleCopy(
                                  `blob-${file.objectId}`,
                                  file.blobId,
                                )
                              }
                              title="Copy blob ID"
                              type="button"
                            >
                              Blob {shortenBlobId(file.blobId)}
                              <span className="copy-status">
                                {copiedKey === `blob-${file.objectId}`
                                  ? "Copied"
                                  : "Copy"}
                              </span>
                            </button>
                          </div>
                          <div className="file-row-meta">
                            {file.contentType ? (
                              <span className="badge-type">
                                {file.contentType}
                              </span>
                            ) : null}
                            <span className="file-size meta-chip">
                              {formatBytes(file.size)}
                            </span>
                            <span className="file-epoch meta-chip">
                              ep.{file.storedUntilEpoch}
                              {currentEpoch !== null ? (
                                <span
                                  className="info-tip"
                                  aria-label={`Expires at Walrus epoch ${file.storedUntilEpoch}. Current epoch: ${currentEpoch}. ${file.storedUntilEpoch - currentEpoch} epoch(s) (~${file.storedUntilEpoch - currentEpoch} day(s)) remaining.`}
                                >
                                  ⓘ
                                </span>
                              ) : null}
                            </span>
                            <span
                              className={`badge-mode ${file.deletable ? "badge-del" : "badge-perm"}`}
                            >
                              {file.deletable ? "deletable" : "permanent"}
                            </span>
                            {file.uploadedAt ? (
                              <span className="meta-chip meta-chip-uploaded">
                                uploaded {formatUploadedAt(file.uploadedAt)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="file-row-actions">
                          {file.deletable ? (
                            <button
                              className="btn btn-danger btn-sm"
                              disabled={deletingObjectId === file.objectId}
                              onClick={() => void handleDelete(file)}
                              title="Delete blob"
                              type="button"
                            >
                              {deletingObjectId === file.objectId
                                ? "…"
                                : "Delete"}
                            </button>
                          ) : null}
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() =>
                              void handleDownload(
                                file.downloadUrl,
                                file.fileName !==
                                  `blob-${file.blobId.slice(0, 10)}`
                                  ? file.fileName
                                  : file.objectId,
                                file.contentType,
                              )
                            }
                            type="button"
                          >
                            ↓
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="state-text">
                    No active files found for this address.
                  </p>
                )
              ) : null}

              {filesTab === "expired" &&
              !walrusFilesQuery.isPending &&
              !walrusFilesQuery.isError ? (
                expiredFiles.length > 0 ? (
                  <div className="file-list">
                    {expiredFiles.map((file) => (
                      <article
                        className="file-row file-row-expired"
                        key={file.objectId}
                      >
                        <div className="file-row-info">
                          <span className="file-name">
                            {getDisplayFileName(file)}
                          </span>
                          <div className="file-id-row mono">
                            <button
                              className="file-id copy-id-btn"
                              onClick={() =>
                                void handleCopy(
                                  `object-${file.objectId}`,
                                  file.objectId,
                                )
                              }
                              title="Copy object ID"
                              type="button"
                            >
                              Object {shortenObjectId(file.objectId)}
                              <span className="copy-status">
                                {copiedKey === `object-${file.objectId}`
                                  ? "Copied"
                                  : "Copy"}
                              </span>
                            </button>
                            <button
                              className="file-id copy-id-btn"
                              onClick={() =>
                                void handleCopy(
                                  `blob-${file.objectId}`,
                                  file.blobId,
                                )
                              }
                              title="Copy blob ID"
                              type="button"
                            >
                              Blob {shortenBlobId(file.blobId)}
                              <span className="copy-status">
                                {copiedKey === `blob-${file.objectId}`
                                  ? "Copied"
                                  : "Copy"}
                              </span>
                            </button>
                          </div>
                          <div className="file-row-meta">
                            {file.contentType ? (
                              <span className="badge-type">
                                {file.contentType}
                              </span>
                            ) : null}
                            <span className="file-size meta-chip">
                              {formatBytes(file.size)}
                            </span>
                            <span className="file-epoch file-epoch-expired meta-chip">
                              ep.{file.storedUntilEpoch}
                              <span
                                className="info-tip"
                                aria-label={`Storage ended at epoch ${file.storedUntilEpoch}. Current epoch: ${currentEpoch ?? "unknown"}. The blob object still exists on Sui but the data may no longer be retrievable.`}
                              >
                                ⓘ
                              </span>
                            </span>
                            <span className="badge-mode badge-expired">
                              expired
                            </span>
                            {file.uploadedAt ? (
                              <span className="meta-chip meta-chip-uploaded">
                                uploaded {formatUploadedAt(file.uploadedAt)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="file-row-actions">
                          {file.deletable ? (
                            <button
                              className="btn btn-danger btn-sm"
                              disabled
                              title="Expired blobs cannot be deleted"
                              type="button"
                            >
                              Delete
                            </button>
                          ) : null}
                          <button
                            className="btn btn-outline btn-sm"
                            disabled
                            title="Storage epoch has ended"
                            type="button"
                          >
                            ↓
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="state-text">
                    No expired files for this address.
                  </p>
                )
              ) : null}

              {filesTab === "deleted" &&
              !deletedFilesQuery.isPending &&
              !deletedFilesQuery.isError ? (
                deletedFiles.length > 0 ? (
                  <div className="file-list">
                    {deletedFiles.map((file) => (
                      <article
                        className="file-row file-row-expired"
                        key={file.objectId}
                      >
                        <div className="file-row-info">
                          <span className="file-name">
                            {getDeletedDisplayName(file)}
                          </span>
                          <div className="file-id-row mono">
                            <button
                              className="file-id copy-id-btn"
                              onClick={() =>
                                void handleCopy(
                                  `deleted-object-${file.objectId}`,
                                  file.objectId,
                                )
                              }
                              title="Copy object ID"
                              type="button"
                            >
                              Object {shortenObjectId(file.objectId)}
                              <span className="copy-status">
                                {copiedKey === `deleted-object-${file.objectId}`
                                  ? "Copied"
                                  : "Copy"}
                              </span>
                            </button>
                            {file.blobId ? (
                              <button
                                className="file-id copy-id-btn"
                                onClick={() =>
                                  void handleCopy(
                                    `deleted-blob-${file.objectId}`,
                                    file.blobId as string,
                                  )
                                }
                                title="Copy blob ID"
                                type="button"
                              >
                                Blob {shortenBlobId(file.blobId)}
                                <span className="copy-status">
                                  {copiedKey === `deleted-blob-${file.objectId}`
                                    ? "Copied"
                                    : "Copy"}
                                </span>
                              </button>
                            ) : null}
                          </div>
                          <div className="file-row-meta">
                            {file.contentType ? (
                              <span className="badge-type">
                                {file.contentType}
                              </span>
                            ) : null}
                            {file.size ? (
                              <span className="file-size meta-chip">
                                {formatBytes(file.size)}
                              </span>
                            ) : null}
                            {file.timestampMs ? (
                              <span className="meta-chip">
                                deleted{" "}
                                {formatDeletedTimestamp(file.timestampMs)}
                              </span>
                            ) : null}
                            <span className="badge-mode badge-expired">
                              deleted
                            </span>
                            {file.uploadedAt ? (
                              <span className="meta-chip meta-chip-uploaded">
                                uploaded {formatUploadedAt(file.uploadedAt)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="state-text">
                    No deleted Walrus blobs found in this wallet&apos;s Sui
                    transaction history.
                  </p>
                )
              ) : null}
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatBalance(balance: string, decimals: number) {
  const value = BigInt(balance);

  if (decimals <= 0) {
    return value.toString();
  }

  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const fraction = value % divisor;
  const fractionText = fraction
    .toString()
    .padStart(decimals, "0")
    .slice(0, 4)
    .replace(/0+$/, "");

  return fractionText
    ? `${whole.toString()}.${fractionText}`
    : whole.toString();
}

function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}\u2026${address.slice(-4)}`;
}

function shortenObjectId(objectId: string): string {
  return shortenAddress(objectId);
}

function shortenBlobId(blobId: string): string {
  if (blobId.length <= 20) {
    return blobId;
  }

  return `${blobId.slice(0, 12)}\u2026${blobId.slice(-6)}`;
}

function isGeneratedFileName(fileName: string, blobId: string): boolean {
  return fileName === `blob-${blobId.slice(0, 10)}`;
}

function getDisplayFileName(file: WalrusBlobRecord): string {
  return isGeneratedFileName(file.fileName, file.blobId)
    ? `File ${shortenObjectId(file.objectId)}`
    : file.fileName;
}

function extractDeletedBlobObjectIds(
  transaction: DeletedHistoryTransaction,
): string[] {
  const programmable = transaction.transaction?.data?.transaction;

  if (
    !programmable ||
    programmable.kind !== "ProgrammableTransaction" ||
    !programmable.transactions ||
    !programmable.inputs
  ) {
    return [];
  }

  const objectIds = new Set<string>();

  for (const command of programmable.transactions) {
    const moveCall = command.MoveCall;

    if (!moveCall) {
      continue;
    }

    if (moveCall.module !== "system" || moveCall.function !== "delete_blob") {
      continue;
    }

    const blobArgument = moveCall.arguments?.[1];

    if (
      !blobArgument ||
      typeof blobArgument === "string" ||
      !("Input" in blobArgument)
    ) {
      continue;
    }

    const input = programmable.inputs[blobArgument.Input];

    if (input?.type === "object" && input.objectId) {
      objectIds.add(input.objectId);
    }
  }

  return Array.from(objectIds);
}

function mergeDeletedBlobRecords(
  chainRecords: DeletedBlobRecord[],
  snapshotRecords: DeletedBlobRecord[],
): DeletedBlobRecord[] {
  const merged = new Map<string, DeletedBlobRecord>();

  for (const record of chainRecords) {
    merged.set(record.objectId, record);
  }

  for (const snapshot of snapshotRecords) {
    const existing = merged.get(snapshot.objectId);
    merged.set(snapshot.objectId, {
      ...existing,
      ...snapshot,
      digest: existing?.digest ?? snapshot.digest,
      timestampMs: existing?.timestampMs ?? snapshot.timestampMs,
    });
  }

  return Array.from(merged.values()).sort(
    (left, right) =>
      Number(right.timestampMs ?? 0) - Number(left.timestampMs ?? 0),
  );
}

function getDeletedDisplayName(file: DeletedBlobRecord): string {
  if (
    file.fileName &&
    file.blobId &&
    !isGeneratedFileName(file.fileName, file.blobId)
  ) {
    return file.fileName;
  }

  return `Deleted ${shortenObjectId(file.objectId)}`;
}

function formatDeletedTimestamp(timestampMs: string): string {
  const value = Number(timestampMs);

  if (!Number.isFinite(value)) {
    return "recently";
  }

  return new Date(value).toLocaleString();
}

function formatUploadedAt(uploadedAt: string): string {
  const value = Date.parse(uploadedAt);

  if (!Number.isFinite(value)) {
    return uploadedAt;
  }

  return new Date(value).toLocaleString();
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/json": ".json",
  "application/octet-stream": ".bin",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/css": ".css",
  "text/csv": ".csv",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
};

function ensureExtension(fileName: string, mimeType: string): string {
  // Already has an extension
  if (/\.[a-zA-Z0-9]+$/.test(fileName)) {
    return fileName;
  }
  const ext = MIME_TO_EXT[mimeType.split(";")[0].trim().toLowerCase()];
  return ext ? `${fileName}${ext}` : fileName;
}

function sniffMimeType(buffer: ArrayBuffer): string | null {
  const b = new Uint8Array(buffer);
  const check = (offset: number, ...bytes: number[]) =>
    bytes.every((byte, i) => b[offset + i] === byte);

  if (check(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return "image/png";
  if (check(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (check(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (check(0, 0x52, 0x49, 0x46, 0x46) && check(8, 0x57, 0x45, 0x42, 0x50))
    return "image/webp";
  if (check(0, 0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (check(0, 0x50, 0x4b, 0x03, 0x04)) return "application/zip";
  if (check(0, 0x1f, 0x8b)) return "application/gzip";
  if (check(0, 0x42, 0x4d)) return "image/bmp";
  if (check(0, 0x49, 0x49, 0x2a, 0x00) || check(0, 0x4d, 0x4d, 0x00, 0x2a))
    return "image/tiff";
  if (check(0, 0x00, 0x00, 0x00) && check(4, 0x66, 0x74, 0x79, 0x70))
    return "video/mp4";
  return null;
}

export default App;
