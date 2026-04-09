import { useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import {
  useCurrentAccount,
  useCurrentClient,
  useCurrentNetwork,
  useCurrentWallet,
  useDAppKit,
  useWallets,
} from "@mysten/dapp-kit-react";
import { isEnokiWallet, isGoogleWallet } from "@mysten/enoki";

import "./App.css";
import {
  formatBlobLabel,
  formatBytes,
  getMaxPublicUploadBytes,
  getRawWalrusBlobObject,
  getWalrusAggregatorUrl,
  getWalrusClient,
  getWalrusDownloadUrl,
  getWalrusPublisherUrl,
  normalizeBlobId,
  type WalrusBlobRecord,
} from "./walrus";
import {
  listLocalDeletedWalrusFiles,
  listLocalWalrusFileMetadata,
  listLocalWalrusWhitelists,
  markLocalWalrusFileDeleted,
  patchLocalWalrusWhitelist,
  saveLocalWalrusWhitelist,
  saveLocalWalrusFile,
  type DeletedBlobRecord,
  type LocalWalrusFileMetadata,
  type LocalWalrusWhitelist,
} from "./localWalrusMetadata";
import {
  buildTransactionKindBytes,
  createSealApprovalTransaction,
  decryptWithSeal,
  encryptWithSeal,
  hexStringToBytes,
} from "./seal";
import {
  clearEnokiIndexedDb,
  clearInvalidEnokiLoginState,
} from "./enokiSession";

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

type WhitelistFeedback = {
  kind: "error" | "success";
  message: string;
};

type FileActionFeedback = {
  kind: "error";
  message: string;
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
const sealPolicyPackageId = import.meta.env.VITE_SEAL_POLICY_PACKAGE_ID as
  | string
  | undefined;
const isSealConfigured = Boolean(sealPolicyPackageId);
const SEAL_POLICY_MODULE_NAME = "whitelist";
const JSON_RPC_URLS = {
  testnet: "https://fullnode.testnet.sui.io:443",
} as const;

type WorkspaceSection = "files" | "lists" | "upload" | "shared" | "assets";

function App() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const currentNetwork = useCurrentNetwork();
  const currentWallet = useCurrentWallet();
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadEncrypt, setUploadEncrypt] = useState(false);
  const [uploadEpochs, setUploadEpochs] = useState("1");
  const [uploadWhitelistId, setUploadWhitelistId] = useState("");
  const [isUploadDeletable, setIsUploadDeletable] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<UploadFeedback | null>(
    null,
  );
  const [fileActionFeedback, setFileActionFeedback] = useState<
    Record<string, FileActionFeedback | undefined>
  >({});
  const [createWhitelistFeedback, setCreateWhitelistFeedback] =
    useState<WhitelistFeedback | null>(null);
  const [whitelistMemberFeedback, setWhitelistMemberFeedback] = useState<
    Record<string, WhitelistFeedback | undefined>
  >({});
  const [deletingObjectId, setDeletingObjectId] = useState<string | null>(null);
  const [filesTab, setFilesTab] = useState<"active" | "expired" | "deleted">(
    "active",
  );
  const [workspaceSection, setWorkspaceSection] =
    useState<WorkspaceSection>("files");
  const [whitelistMemberInputs, setWhitelistMemberInputs] = useState<
    Record<string, string>
  >({});
  const [updatingWhitelistId, setUpdatingWhitelistId] = useState<string | null>(
    null,
  );
  const [newWhitelistName, setNewWhitelistName] = useState("");
  const [isCreatingWhitelist, setIsCreatingWhitelist] = useState(false);
  const [downloadingObjectId, setDownloadingObjectId] = useState<string | null>(
    null,
  );
  const [sharedBlobIdInput, setSharedBlobIdInput] = useState("");
  const [sharedKeyIdInput, setSharedKeyIdInput] = useState("");
  const [sharedFileNameInput, setSharedFileNameInput] = useState("");
  const [sharedAccessError, setSharedAccessError] = useState<string | null>(
    null,
  );
  const [hiddenDeletedObjectIds, setHiddenDeletedObjectIds] = useState<
    string[]
  >([]);
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
  const browserWallet = useMemo(() => {
    const nonEnokiWallets = wallets.filter(
      (wallet) =>
        !isEnokiWallet(
          wallet as unknown as Parameters<typeof isEnokiWallet>[0],
        ),
    );

    return (
      nonEnokiWallets.find((wallet) =>
        wallet.name.toLowerCase().includes("slush"),
      ) ??
      nonEnokiWallets[0] ??
      null
    );
  }, [wallets]);

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

  const whitelistsQuery = useQuery({
    queryKey: ["walrus-whitelists", currentNetwork, account?.address],
    enabled: Boolean(account),
    queryFn: async (): Promise<LocalWalrusWhitelist[]> => {
      if (!account) {
        return [];
      }

      return listLocalWalrusWhitelists(currentNetwork, account.address);
    },
  });

  const walrusFilesQuery = useQuery({
    queryKey: ["walrus-files", currentNetwork, account?.address],
    enabled: Boolean(account),
    queryFn: async (): Promise<WalrusBlobRecord[]> => {
      if (!account) {
        return [];
      }

      const localMetadataByObjectId = new Map<string, LocalWalrusFileMetadata>(
        listLocalWalrusFileMetadata(currentNetwork, account.address).map(
          (metadata) => [metadata.objectId, metadata],
        ),
      );

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

            const normalizedBlobId = normalizeBlobId(blobObject.blob_id);
            const localMetadata = localMetadataByObjectId.get(objectId) ?? null;
            const fileName =
              localMetadata?.fileName ?? formatBlobLabel(normalizedBlobId);
            const contentType = localMetadata?.contentType ?? null;
            const uploadedAt = localMetadata?.uploadedAt ?? null;

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

    console.log("[auth] google-login:start", {
      currentNetwork,
      walletAccounts: googleWallet.accounts.map(
        (walletAccount) => walletAccount.address,
      ),
      walletName: googleWallet.name,
    });

    setLoginError(null);
    setIsSigningIn(true);

    try {
      await clearInvalidEnokiLoginState({
        network: currentNetwork,
        wallet: googleWallet,
      });

      const result = await dAppKit.connectWallet({ wallet: googleWallet });

      console.log("[auth] google-login:connected", {
        accounts: result.accounts.map((walletAccount) => walletAccount.address),
        currentNetwork,
      });

      if (!result.accounts.length) {
        setLoginError(
          "Google sign-in finished, but no wallet account was returned. Check the Enoki allow list and your Google redirect URI configuration.",
        );
      }
    } catch (error) {
      console.error("[auth] google-login:error", error);
      setLoginError(formatLoginError(error));
    } finally {
      console.log("[auth] google-login:done", {
        currentNetwork,
      });
      setIsSigningIn(false);
    }
  }

  async function handleBrowserWalletLogin() {
    if (!browserWallet) {
      return;
    }

    console.log("[auth] browser-wallet-login:start", {
      currentNetwork,
      walletAccounts: browserWallet.accounts.map(
        (walletAccount) => walletAccount.address,
      ),
      walletName: browserWallet.name,
    });

    setLoginError(null);
    setIsSigningIn(true);

    try {
      const result = await dAppKit.connectWallet({ wallet: browserWallet });

      console.log("[auth] browser-wallet-login:connected", {
        accounts: result.accounts.map((walletAccount) => walletAccount.address),
        currentNetwork,
        walletName: browserWallet.name,
      });

      if (!result.accounts.length) {
        setLoginError(
          `${browserWallet.name} connected, but no wallet account was returned.`,
        );
      }
    } catch (error) {
      console.error("[auth] browser-wallet-login:error", error);
      setLoginError(formatLoginError(error));
    } finally {
      console.log("[auth] browser-wallet-login:done", {
        currentNetwork,
        walletName: browserWallet.name,
      });
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
    // await delay(900);
    // window.location.reload();
  }

  async function refreshWalrusFilesUntilVisible(objectId: string) {
    console.log(
      "[walrus] refreshWalrusFilesUntilVisible: waiting for objectId",
      objectId,
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await walrusFilesQuery.refetch();
      const foundIds = result.data?.map((file) => file.objectId) ?? [];
      console.log(
        `[walrus] attempt ${attempt + 1}: owned blob objectIds =`,
        foundIds,
      );

      if (result.data?.some((file) => file.objectId === objectId)) {
        console.log("[walrus] objectId found in list, done.");
        return;
      }

      if (attempt < 3) {
        console.log("[walrus] objectId not found yet, retrying in 1200ms...");
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

  async function createWhitelist(name: string) {
    if (!historyClient || !sealPolicyPackageId) {
      throw new Error(
        "Seal allowlist is not configured. Publish the Move package and set VITE_SEAL_POLICY_PACKAGE_ID.",
      );
    }

    console.log("[whitelist] create:start", {
      accountAddress: account?.address ?? null,
      currentNetwork,
      name,
      packageId: sealPolicyPackageId,
    });

    const transaction = new Transaction();
    transaction.moveCall({
      target: `${sealPolicyPackageId}::${SEAL_POLICY_MODULE_NAME}::create_whitelist_entry`,
      arguments: [],
    });

    const result = await signAndExecuteTransaction(transaction);
    const digest = getTransactionDigest(result);

    console.log("[whitelist] create:submitted", {
      digest,
      rawResult: result,
    });

    if (!digest) {
      throw new Error(
        "The whitelist transaction completed without returning a digest.",
      );
    }

    const txBlock = await historyClient.waitForTransaction({
      digest,
      options: {
        showObjectChanges: true,
      },
      timeout: 30_000,
      pollInterval: 1_500,
    });

    console.log("[whitelist] create:confirmed", {
      digest,
      objectChanges: txBlock.objectChanges ?? [],
    });

    const created = extractWhitelistCreation(txBlock, sealPolicyPackageId);

    console.log("[whitelist] create:extracted", {
      capId: created.capId,
      digest,
      whitelistId: created.whitelistId,
    });

    if (!account) {
      throw new Error("No connected account for whitelist creation.");
    }

    saveLocalWalrusWhitelist(currentNetwork, account.address, {
      capId: created.capId,
      createdAt: new Date().toISOString(),
      id: created.whitelistId,
      members: [normalizeSuiAddress(account.address)],
      name,
      ownerAddress: normalizeSuiAddress(account.address),
      packageId: sealPolicyPackageId,
    });

    console.log("[whitelist] create:stored-local", {
      capId: created.capId,
      memberCount: 1,
      ownerAddress: normalizeSuiAddress(account.address),
      whitelistId: created.whitelistId,
    });

    await whitelistsQuery.refetch();

    console.log("[whitelist] create:refetched", {
      whitelistCount: whitelistsQuery.data?.length ?? null,
    });

    return created;
  }

  async function handleCreateWhitelist() {
    if (!account) {
      return;
    }

    if (!sealPolicyPackageId) {
      setCreateWhitelistFeedback({
        kind: "error",
        message:
          "Set VITE_SEAL_POLICY_PACKAGE_ID after publishing the whitelist package before creating a list.",
      });
      return;
    }

    const trimmedName = newWhitelistName.trim();

    if (!trimmedName) {
      setCreateWhitelistFeedback({
        kind: "error",
        message: "Enter a name for the whitelist.",
      });
      return;
    }

    console.log("[whitelist] create:ui-request", {
      accountAddress: account.address,
      newWhitelistName,
      trimmedName,
    });

    setCreateWhitelistFeedback(null);
    setIsCreatingWhitelist(true);

    try {
      const created = await createWhitelist(trimmedName);
      console.log("[whitelist] create:ui-success", created);
      setNewWhitelistName("");
      setUploadWhitelistId(created.whitelistId);
      setCreateWhitelistFeedback({
        kind: "success",
        message: `Created whitelist "${trimmedName}".`,
      });
    } catch (error) {
      console.error("Create whitelist error:", error);
      setCreateWhitelistFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Failed to create whitelist",
      });
    } finally {
      setIsCreatingWhitelist(false);
    }
  }

  async function handleWalrusUpload() {
    if (!account || !uploadFile) {
      return;
    }

    if (uploadEncrypt && !sealPolicyPackageId) {
      setUploadError(
        "Set VITE_SEAL_POLICY_PACKAGE_ID after publishing the whitelist package before uploading encrypted files.",
      );
      return;
    }

    if (uploadEncrypt && !historyClient) {
      setUploadError(
        "Could not create the whitelist policy client for this network.",
      );
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
      const sealClient = historyClient ?? client;
      const plainBytes = new Uint8Array(await uploadFile.arrayBuffer());
      let uploadBytes: Uint8Array = plainBytes;
      let selectedWhitelist: LocalWalrusWhitelist | null = null;
      let keyId: string | null = null;

      if (uploadEncrypt) {
        selectedWhitelist =
          (whitelistsQuery.data ?? []).find(
            (whitelist) => whitelist.id === uploadWhitelistId,
          ) ?? null;

        if (!selectedWhitelist) {
          throw new Error(
            "Choose a whitelist before uploading an encrypted file.",
          );
        }

        keyId = createKeyIdForWhitelist(selectedWhitelist.id);
        const encrypted = await encryptWithSeal({
          data: plainBytes,
          id: keyId,
          packageId: sealPolicyPackageId as string,
          suiClient: sealClient,
        });
        uploadBytes = encrypted.encryptedObject;

        console.log("[seal-upload] prepared encrypted upload", {
          blobContentType: uploadFile.type || "application/octet-stream",
          fileName: uploadFile.name,
          keyId,
          packageId: sealPolicyPackageId,
          whitelistId: selectedWhitelist.id,
          whitelistName: selectedWhitelist.name,
        });
      }

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
          body: toArrayBuffer(uploadBytes),
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

        const normalizedBlobId = normalizeBlobId(newlyCreatedBlob.blobId);
        const uploadedAt = new Date().toISOString();

        saveLocalWalrusFile(
          currentNetwork,
          account.address,
          {
            blobId: normalizedBlobId,
            contentType: uploadFile.type || "application/octet-stream",
            fileName: uploadFile.name || formatBlobLabel(normalizedBlobId),
            objectId: newObjectId,
            uploadedAt,
          },
          {
            encrypted: uploadEncrypt,
            keyId,
            packageId: uploadEncrypt ? (sealPolicyPackageId ?? null) : null,
            whitelistCapId: selectedWhitelist?.capId ?? null,
            whitelistId: selectedWhitelist?.id ?? null,
            whitelistName: selectedWhitelist?.name ?? null,
          },
        );

        console.log("[seal-upload] stored local metadata", {
          blobId: normalizedBlobId,
          encrypted: uploadEncrypt,
          keyId,
          objectId: newObjectId,
          whitelistId: selectedWhitelist?.id ?? null,
          whitelistName: selectedWhitelist?.name ?? null,
        });

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
      setUploadEncrypt(false);
      setUploadEpochs("1");
      setUploadWhitelistId("");
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

    console.log("[auth] logout:start", {
      accountAddress: account?.address ?? null,
      currentNetwork,
      hasCurrentWallet: Boolean(currentWallet),
    });

    try {
      await dAppKit.disconnectWallet();
    } finally {
      if (currentWallet && isEnokiWallet(currentWallet)) {
        await clearEnokiIndexedDb({ network: currentNetwork });
      }

      console.log("[auth] logout:done", {
        currentNetwork,
      });

      window.location.reload();
    }
  }

  async function signAndExecuteTransaction(transaction: Transaction) {
    console.log("[tx] sign-and-execute:start", {
      accountAddress: account?.address ?? null,
      currentNetwork,
      transactionData: transaction.getData(),
    });

    await ensureWalletHasGasBalance();

    const result = await dAppKit.signAndExecuteTransaction({ transaction });

    console.log("[tx] sign-and-execute:done", {
      digest: getTransactionDigest(result),
      result,
    });

    return result;
  }

  async function handleDownload(
    url: string,
    fileName: string,
    contentType: string | null,
    objectId?: string,
  ) {
    if (objectId) {
      setFileActionFeedback((current) => ({
        ...current,
        [objectId]: undefined,
      }));
      setDownloadingObjectId(objectId);
    }

    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const mimeType = resolveDownloadMimeType(
        arrayBuffer,
        contentType,
        response.headers.get("content-type"),
      );

      triggerFileDownload(arrayBuffer, fileName, mimeType);
    } catch (error) {
      if (objectId) {
        setFileActionFeedback((current) => ({
          ...current,
          [objectId]: {
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to download file",
          },
        }));
      }
    } finally {
      if (objectId) {
        setDownloadingObjectId(null);
      }
    }
  }

  function getStoredLocalMetadata(objectId: string) {
    if (!account) {
      return null;
    }

    return (
      listLocalWalrusFileMetadata(currentNetwork, account.address).find(
        (file) => file.objectId === objectId,
      ) ?? null
    );
  }

  function getStoredWhitelist(whitelistId: string | null) {
    if (!whitelistId || !account) {
      return null;
    }

    return (
      listLocalWalrusWhitelists(currentNetwork, account.address).find(
        (whitelist) => whitelist.id === whitelistId,
      ) ?? null
    );
  }

  async function handleEncryptedDownload(
    file: WalrusBlobRecord,
    metadata: LocalWalrusFileMetadata,
  ) {
    if (!account) {
      return;
    }

    const packageId = metadata.packageId ?? sealPolicyPackageId;

    if (!packageId || !metadata.keyId) {
      setFileActionFeedback((current) => ({
        ...current,
        [file.objectId]: {
          kind: "error",
          message:
            "Missing local Seal metadata for this file. The key ID is required for decryption.",
        },
      }));
      return;
    }

    setDownloadingObjectId(file.objectId);
    setFileActionFeedback((current) => ({
      ...current,
      [file.objectId]: undefined,
    }));

    try {
      const response = await fetch(file.downloadUrl);
      const encryptedBytes = new Uint8Array(await response.arrayBuffer());
      const whitelistId =
        metadata.whitelistId ?? deriveWhitelistIdFromKeyId(metadata.keyId);
      const keyIdBytes = hexStringToBytes(metadata.keyId);

      console.log("[seal-download] decrypt:start", {
        accountAddress: account.address,
        blobId: file.blobId,
        encryptedBytes: encryptedBytes.byteLength,
        keyId: metadata.keyId,
        keyIdBytes: keyIdBytes.byteLength,
        keyIdPrefixMatchesWhitelist: doesKeyIdMatchWhitelist(
          metadata.keyId,
          whitelistId,
        ),
        objectId: file.objectId,
        packageId,
        storedWhitelistId: metadata.whitelistId,
        derivedWhitelistId: deriveWhitelistIdFromKeyId(metadata.keyId),
      });

      const approvalTransaction = createSealApprovalTransaction({
        additionalArguments: (transaction: Transaction) => [
          transaction.object(whitelistId),
        ],
        idBytes: keyIdBytes,
        moduleName: SEAL_POLICY_MODULE_NAME,
        packageId,
      });
      const txBytes = await buildTransactionKindBytes(
        historyClient ?? client,
        approvalTransaction,
      );

      console.log("[seal-download] decrypt:approval-ptb", {
        packageId,
        txBytes: txBytes.byteLength,
        whitelistId,
      });

      const decryptedBytes = await decryptWithSeal({
        address: account.address,
        dAppKit,
        encryptedBytes,
        packageId,
        suiClient: historyClient ?? client,
        txBytes,
      });
      const plainArrayBuffer = toArrayBuffer(decryptedBytes);
      const mimeType = resolveDownloadMimeType(
        plainArrayBuffer,
        metadata.contentType,
      );

      triggerFileDownload(
        plainArrayBuffer,
        metadata.fileName ?? file.fileName,
        mimeType,
      );
    } catch (error) {
      console.error("[seal-download] decrypt:error", {
        accountAddress: account.address,
        blobId: file.blobId,
        keyId: metadata.keyId,
        objectId: file.objectId,
        packageId,
        storedWhitelistId: metadata.whitelistId,
        error,
      });

      setFileActionFeedback((current) => ({
        ...current,
        [file.objectId]: {
          kind: "error",
          message:
            error instanceof Error ? error.message : "Failed to decrypt file",
        },
      }));
    } finally {
      setDownloadingObjectId(null);
    }
  }

  async function handleSharedAccessDownload() {
    if (!account) {
      return;
    }

    if (!sealPolicyPackageId) {
      setSharedAccessError(
        "Set VITE_SEAL_POLICY_PACKAGE_ID before opening a shared encrypted file.",
      );
      return;
    }

    setSharedAccessError(null);
    setDownloadingObjectId("shared-access");

    try {
      const blobId = normalizeBlobId(sharedBlobIdInput.trim());
      const keyId = sharedKeyIdInput.trim();

      if (!blobId || !keyId) {
        throw new Error("Blob ID and key ID are required.");
      }

      const response = await fetch(getWalrusDownloadUrl(blobId));
      const encryptedBytes = new Uint8Array(await response.arrayBuffer());
      const whitelistId = deriveWhitelistIdFromKeyId(keyId);
      const keyIdBytes = hexStringToBytes(keyId);

      console.log("[seal-shared] decrypt:start", {
        accountAddress: account.address,
        blobId,
        encryptedBytes: encryptedBytes.byteLength,
        keyId,
        keyIdBytes: keyIdBytes.byteLength,
        keyIdPrefixMatchesWhitelist: doesKeyIdMatchWhitelist(
          keyId,
          whitelistId,
        ),
        packageId: sealPolicyPackageId,
        whitelistId,
      });

      const approvalTransaction = createSealApprovalTransaction({
        additionalArguments: (transaction: Transaction) => [
          transaction.object(whitelistId),
        ],
        idBytes: keyIdBytes,
        moduleName: SEAL_POLICY_MODULE_NAME,
        packageId: sealPolicyPackageId,
      });
      const txBytes = await buildTransactionKindBytes(
        historyClient ?? client,
        approvalTransaction,
      );

      console.log("[seal-shared] decrypt:approval-ptb", {
        packageId: sealPolicyPackageId,
        txBytes: txBytes.byteLength,
        whitelistId,
      });

      const decryptedBytes = await decryptWithSeal({
        address: account.address,
        dAppKit,
        encryptedBytes,
        packageId: sealPolicyPackageId,
        suiClient: historyClient ?? client,
        txBytes,
      });
      const plainArrayBuffer = toArrayBuffer(decryptedBytes);
      const mimeType = resolveDownloadMimeType(plainArrayBuffer, null);

      triggerFileDownload(
        plainArrayBuffer,
        sharedFileNameInput.trim() || formatBlobLabel(blobId),
        mimeType,
      );
    } catch (error) {
      console.error("[seal-shared] decrypt:error", {
        accountAddress: account.address,
        blobId: sharedBlobIdInput.trim(),
        keyId: sharedKeyIdInput.trim(),
        packageId: sealPolicyPackageId,
        error,
      });

      setSharedAccessError(
        error instanceof Error
          ? error.message
          : "Failed to decrypt shared file",
      );
    } finally {
      setDownloadingObjectId(null);
    }
  }

  async function handleWhitelistMemberUpdate(
    whitelist: LocalWalrusWhitelist,
    accountAddress: string,
    action: "add" | "remove",
  ) {
    if (!account) {
      return;
    }

    console.log("[whitelist] member-update:start", {
      action,
      accountAddress: account.address,
      memberCount: whitelist.members.length,
      packageId: whitelist.packageId ?? sealPolicyPackageId ?? null,
      targetAddress: accountAddress,
      whitelistCapId: whitelist.capId,
      whitelistId: whitelist.id,
      whitelistMembers: whitelist.members,
    });

    const trimmedAddress = accountAddress.trim();

    if (action === "add" && !trimmedAddress) {
      setWhitelistMemberFeedback((current) => ({
        ...current,
        [whitelist.id]: {
          kind: "error",
          message: "Enter a Sui address to add.",
        },
      }));
      return;
    }

    if (!isValidSuiAddress(trimmedAddress)) {
      setWhitelistMemberFeedback((current) => ({
        ...current,
        [whitelist.id]: {
          kind: "error",
          message: "Enter a valid Sui address.",
        },
      }));
      return;
    }

    const normalizedAddress = normalizeSuiAddress(trimmedAddress);

    if (
      action === "add" &&
      whitelist.members.some(
        (member) => normalizeSuiAddress(member) === normalizedAddress,
      )
    ) {
      setWhitelistMemberFeedback((current) => ({
        ...current,
        [whitelist.id]: {
          kind: "error",
          message: "That address is already in the whitelist.",
        },
      }));
      return;
    }

    const packageId = whitelist.packageId ?? sealPolicyPackageId;

    if (!packageId) {
      setWhitelistMemberFeedback((current) => ({
        ...current,
        [whitelist.id]: {
          kind: "error",
          message: "Missing Seal policy package ID.",
        },
      }));
      return;
    }

    setWhitelistMemberFeedback((current) => ({
      ...current,
      [whitelist.id]: undefined,
    }));
    setUpdatingWhitelistId(whitelist.id);

    try {
      const transaction = new Transaction();
      transaction.moveCall({
        target: `${packageId}::${SEAL_POLICY_MODULE_NAME}::${action === "add" ? "add_member" : "remove_member"}`,
        arguments: [
          transaction.object(whitelist.id),
          transaction.object(whitelist.capId),
          transaction.pure.address(normalizedAddress),
        ],
      });

      await signAndExecuteTransaction(transaction);

      console.log("[whitelist] member-update:chain-success", {
        action,
        normalizedAddress,
        whitelistId: whitelist.id,
      });

      const nextMembers =
        action === "add"
          ? Array.from(new Set([...whitelist.members, normalizedAddress]))
          : whitelist.members.filter((value) => value !== normalizedAddress);

      patchLocalWalrusWhitelist(currentNetwork, account.address, whitelist.id, {
        members: nextMembers,
      });

      console.log("[whitelist] member-update:stored-local", {
        action,
        nextMembers,
        whitelistId: whitelist.id,
      });

      await whitelistsQuery.refetch();

      console.log("[whitelist] member-update:refetched", {
        action,
        whitelistId: whitelist.id,
      });

      setWhitelistMemberFeedback((current) => ({
        ...current,
        [whitelist.id]: {
          kind: "success",
          message:
            action === "add"
              ? `Added ${shortenAddress(normalizedAddress)} to ${whitelist.name}.`
              : `Removed ${shortenAddress(normalizedAddress)} from ${whitelist.name}.`,
        },
      }));

      if (action === "add") {
        setWhitelistMemberInputs((current) => ({
          ...current,
          [whitelist.id]: "",
        }));
      }
    } catch (error) {
      console.error("Whitelist update error:", error);
      setWhitelistMemberFeedback((current) => ({
        ...current,
        [whitelist.id]: {
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to update whitelist",
        },
      }));
    } finally {
      setUpdatingWhitelistId(null);
    }
  }

  async function ensureWalletHasGasBalance() {
    if (!account) {
      throw new Error("Connect a wallet before sending a transaction.");
    }

    const { balances } = await client.listBalances({
      owner: account.address,
    });

    const suiBalance = balances
      .filter((balance) => balance.coinType.endsWith("::sui::SUI"))
      .reduce((total, balance) => total + BigInt(balance.balance), 0n);

    if (suiBalance <= 0n) {
      throw new Error("This wallet has no SUI available for gas.");
    }
  }

  function canAddWhitelistMember(
    whitelist: LocalWalrusWhitelist,
    accountAddress: string,
  ) {
    const trimmedAddress = accountAddress.trim();

    if (!trimmedAddress || !isValidSuiAddress(trimmedAddress)) {
      return false;
    }

    const normalizedAddress = normalizeSuiAddress(trimmedAddress);

    return !whitelist.members.some(
      (member) => normalizeSuiAddress(member) === normalizedAddress,
    );
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

    setFileActionFeedback((current) => ({
      ...current,
      [file.objectId]: undefined,
    }));
    setDeletingObjectId(file.objectId);

    try {
      const transaction = walrusClient.walrus.deleteBlobTransaction({
        blobObjectId: file.objectId,
        owner: account.address,
      });

      await signAndExecuteTransaction(transaction);

      markLocalWalrusFileDeleted(currentNetwork, account.address, file);
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
      setFileActionFeedback((current) => ({
        ...current,
        [file.objectId]: {
          kind: "error",
          message:
            error instanceof Error ? error.message : "Failed to delete file",
        },
      }));
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

      return mergeDeletedBlobRecords(
        Array.from(
          new Map(
            (response.data as DeletedHistoryTransaction[]).flatMap((tx) =>
              extractDeletedBlobObjectIds(tx).map((objectId) => [
                objectId,
                {
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
                } satisfies DeletedBlobRecord,
              ]),
            ),
          ).values(),
        ),
        listLocalDeletedWalrusFiles(currentNetwork, account.address),
      );
    },
  });

  const currentEpoch = walrusEpochQuery.data ?? null;
  const whitelists = whitelistsQuery.data ?? [];
  const allFiles = (walrusFilesQuery.data ?? []).filter(
    (file) => !hiddenDeletedObjectIds.includes(file.objectId),
  );
  const deletedFiles = deletedFilesQuery.data ?? [];
  const activeFiles =
    currentEpoch !== null
      ? allFiles.filter((f) => f.storedUntilEpoch > currentEpoch)
      : allFiles;
  const expiredFiles =
    currentEpoch !== null
      ? allFiles.filter((f) => f.storedUntilEpoch <= currentEpoch)
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
                type="button"
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
            <div className="login-actions">
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
              <button
                className="btn btn-outline btn-large"
                disabled={!browserWallet || isSigningIn}
                onClick={() => void handleBrowserWalletLogin()}
                type="button"
              >
                {isSigningIn
                  ? "Connecting\u2026"
                  : `Continue with ${browserWallet?.name ?? "browser wallet"}`}
              </button>
            </div>
            {!googleWallet && !browserWallet && isConfigured ? (
              <p className="hint-text">Registering wallet providers\u2026</p>
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
                <span className="stat-num">{activeCount}</span>
                <span className="stat-lbl">Active files</span>
              </div>
              <div className="stat-sep" />
              <div className="stat-item">
                <span className="stat-num">{expiredCount}</span>
                <span className="stat-lbl">Expired files</span>
              </div>
              <div className="stat-sep" />
              <div className="stat-item">
                <span className="stat-num">{deletedCount}</span>
                <span className="stat-lbl">Deleted files</span>
              </div>
              <div className="stat-sep" />
              <div className="stat-item">
                <span className="stat-num">{totalAssets}</span>
                <span className="stat-lbl">Wallet assets</span>
              </div>
            </div>
          </div>

          {/* Workspace */}
          <div className="workspace">
            <aside className="card workspace-nav">
              <div className="workspace-nav-header">
                <p className="workspace-nav-eyebrow">Workspace</p>
                <h2 className="workspace-nav-title">Control Center</h2>
              </div>

              <div className="workspace-nav-list">
                <button
                  className={`workspace-nav-item ${workspaceSection === "files" ? "workspace-nav-item-active" : ""}`}
                  onClick={() => setWorkspaceSection("files")}
                  type="button"
                >
                  <span className="workspace-nav-item-label">Files</span>
                  <span className="workspace-nav-item-meta">{totalFiles}</span>
                </button>
                <button
                  className={`workspace-nav-item ${workspaceSection === "lists" ? "workspace-nav-item-active" : ""}`}
                  onClick={() => setWorkspaceSection("lists")}
                  type="button"
                >
                  <span className="workspace-nav-item-label">Whitelists</span>
                  <span className="workspace-nav-item-meta">
                    {whitelists.length}
                  </span>
                </button>
                <button
                  className={`workspace-nav-item ${workspaceSection === "upload" ? "workspace-nav-item-active" : ""}`}
                  onClick={() => setWorkspaceSection("upload")}
                  type="button"
                >
                  <span className="workspace-nav-item-label">Upload</span>
                  <span className="workspace-nav-item-meta">
                    {uploadEncrypt ? "Seal" : "Walrus"}
                  </span>
                </button>
                <button
                  className={`workspace-nav-item ${workspaceSection === "shared" ? "workspace-nav-item-active" : ""}`}
                  onClick={() => setWorkspaceSection("shared")}
                  type="button"
                >
                  <span className="workspace-nav-item-label">
                    Shared Access
                  </span>
                  <span className="workspace-nav-item-meta">Open</span>
                </button>
                <button
                  className={`workspace-nav-item ${workspaceSection === "assets" ? "workspace-nav-item-active" : ""}`}
                  onClick={() => setWorkspaceSection("assets")}
                  type="button"
                >
                  <span className="workspace-nav-item-label">Assets</span>
                  <span className="workspace-nav-item-meta">{totalAssets}</span>
                </button>
              </div>

              <div className="workspace-nav-summary">
                <span className="workspace-nav-summary-label">
                  Active network
                </span>
                <span className="workspace-nav-summary-value">
                  {currentNetwork}
                </span>
              </div>
            </aside>

            <div className="workspace-main">
              {workspaceSection === "lists" ? (
                <section className="card workspace-panel">
                  <div className="card-header">
                    <h2>
                      Whitelists
                      <span className="count-badge">{whitelists.length}</span>
                    </h2>
                  </div>
                  <div className="whitelist-layout">
                    <div className="whitelist-create-section">
                      <div className="whitelist-section-heading">
                        <h3 className="whitelist-section-title">Create</h3>
                      </div>
                      {createWhitelistFeedback ? (
                        <p
                          className={
                            createWhitelistFeedback.kind === "error"
                              ? "feedback-error"
                              : "feedback-success"
                          }
                        >
                          {createWhitelistFeedback.message}
                        </p>
                      ) : null}
                      <div className="file-share-form whitelist-create-form">
                        <input
                          className="text-input"
                          placeholder="Team Alpha"
                          value={newWhitelistName}
                          onChange={(event) =>
                            setNewWhitelistName(event.target.value)
                          }
                        />
                        <button
                          className="btn btn-black btn-sm"
                          disabled={
                            isCreatingWhitelist ||
                            !isSealConfigured ||
                            !newWhitelistName.trim()
                          }
                          onClick={() => void handleCreateWhitelist()}
                          type="button"
                        >
                          {isCreatingWhitelist ? "Creating\u2026" : "Create"}
                        </button>
                      </div>

                      {!isSealConfigured ? (
                        <p className="feedback-error">
                          Add <code>VITE_SEAL_POLICY_PACKAGE_ID</code> after
                          publishing the whitelist package to create and manage
                          lists.
                        </p>
                      ) : null}
                    </div>

                    <div className="whitelist-list-section">
                      <div className="whitelist-section-heading">
                        <h3 className="whitelist-section-title">Manage</h3>
                      </div>
                      {whitelists.length > 0 ? (
                        <div className="whitelist-list">
                          {whitelists.map((whitelist) => (
                            <article
                              className="whitelist-card"
                              key={whitelist.id}
                            >
                              <div className="whitelist-card-header">
                                <div>
                                  <div className="whitelist-name">
                                    {whitelist.name}
                                  </div>
                                  <button
                                    className="file-id copy-id-btn"
                                    onClick={() =>
                                      void handleCopy(
                                        `whitelist-${whitelist.id}`,
                                        whitelist.id,
                                      )
                                    }
                                    title="Copy whitelist ID"
                                    type="button"
                                  >
                                    List {shortenObjectId(whitelist.id)}
                                    <span className="copy-status">
                                      {copiedKey === `whitelist-${whitelist.id}`
                                        ? "Copied"
                                        : "Copy"}
                                    </span>
                                  </button>
                                </div>
                                <span className="meta-chip meta-chip-uploaded">
                                  {whitelist.members.length} member
                                  {whitelist.members.length === 1 ? "" : "s"}
                                </span>
                              </div>

                              <div className="whitelist-card-section">
                                <div className="whitelist-card-section-header">
                                  <span className="share-label">Members</span>
                                </div>
                                <div className="file-share-members">
                                  {whitelist.members.map((member) => {
                                    const isOwner =
                                      normalizeSuiAddress(member) ===
                                      normalizeSuiAddress(
                                        whitelist.ownerAddress,
                                      );

                                    return (
                                      <button
                                        key={member}
                                        className="share-member-chip"
                                        disabled={
                                          isOwner ||
                                          updatingWhitelistId === whitelist.id
                                        }
                                        onClick={() =>
                                          void handleWhitelistMemberUpdate(
                                            whitelist,
                                            member,
                                            "remove",
                                          )
                                        }
                                        title={
                                          isOwner
                                            ? "Creator keeps access by default"
                                            : "Remove member"
                                        }
                                        type="button"
                                      >
                                        {shortenAddress(member)}
                                        <span className="share-member-remove">
                                          {isOwner ? "owner" : "×"}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>

                              <div className="whitelist-card-section whitelist-card-section-accent">
                                <div className="whitelist-card-section-header">
                                  <span className="share-label">
                                    Add member
                                  </span>
                                </div>
                                <div className="file-share-form whitelist-member-form">
                                  <input
                                    className="text-input mono"
                                    placeholder="0x..."
                                    value={
                                      whitelistMemberInputs[whitelist.id] ?? ""
                                    }
                                    onChange={(event) =>
                                      setWhitelistMemberInputs((current) => ({
                                        ...current,
                                        [whitelist.id]: event.target.value,
                                      }))
                                    }
                                  />
                                  <button
                                    className="btn btn-outline btn-sm"
                                    disabled={
                                      updatingWhitelistId === whitelist.id ||
                                      !canAddWhitelistMember(
                                        whitelist,
                                        whitelistMemberInputs[whitelist.id] ??
                                          "",
                                      )
                                    }
                                    onClick={() =>
                                      void handleWhitelistMemberUpdate(
                                        whitelist,
                                        whitelistMemberInputs[whitelist.id] ??
                                          "",
                                        "add",
                                      )
                                    }
                                    type="button"
                                  >
                                    {updatingWhitelistId === whitelist.id
                                      ? "Saving\u2026"
                                      : "Add member"}
                                  </button>
                                </div>
                                {whitelistMemberFeedback[whitelist.id] ? (
                                  <p
                                    className={
                                      whitelistMemberFeedback[whitelist.id]
                                        ?.kind === "error"
                                        ? "feedback-error"
                                        : "feedback-success"
                                    }
                                  >
                                    {
                                      whitelistMemberFeedback[whitelist.id]
                                        ?.message
                                    }
                                  </p>
                                ) : null}
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="whitelist-empty-state">
                          <span className="whitelist-empty-count">0</span>
                          <span className="whitelist-empty-label">Lists</span>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              ) : null}

              {workspaceSection === "upload" ? (
                <section className="card workspace-panel">
                  <div className="card-header">
                    <h2>Upload</h2>
                  </div>
                  <div className="upload-form">
                    <div className="form-field">
                      <label
                        className="field-label"
                        htmlFor="walrus-file-input"
                      >
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
                      <label
                        className="toggle-field"
                        htmlFor="walrus-encrypt-toggle"
                      >
                        <input
                          id="walrus-encrypt-toggle"
                          type="checkbox"
                          checked={uploadEncrypt}
                          onChange={(event) => {
                            const nextChecked = event.target.checked;
                            setUploadEncrypt(nextChecked);
                            if (!nextChecked) {
                              setUploadWhitelistId("");
                            }
                          }}
                        />
                        <span>Encrypt with Seal</span>
                      </label>
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

                    {uploadEncrypt ? (
                      <div className="form-field">
                        <label
                          className="field-label"
                          htmlFor="walrus-whitelist-select"
                        >
                          Whitelist
                        </label>
                        <select
                          id="walrus-whitelist-select"
                          className="text-input"
                          value={uploadWhitelistId}
                          onChange={(event) =>
                            setUploadWhitelistId(event.target.value)
                          }
                        >
                          <option value="">Select a whitelist</option>
                          {whitelists.map((whitelist) => (
                            <option key={whitelist.id} value={whitelist.id}>
                              {whitelist.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}

                    <button
                      className="btn btn-black"
                      disabled={
                        !uploadFile ||
                        isUploading ||
                        (uploadEncrypt &&
                          (!isSealConfigured || !uploadWhitelistId))
                      }
                      onClick={() => void handleWalrusUpload()}
                    >
                      {isUploading
                        ? "Uploading\u2026"
                        : uploadEncrypt
                          ? "Encrypt & upload"
                          : "Upload to Walrus"}
                    </button>

                    {uploadEncrypt && !isSealConfigured ? (
                      <p className="feedback-error">
                        Add <code>VITE_SEAL_POLICY_PACKAGE_ID</code> after
                        publishing the whitelist package to enable encrypted
                        uploads.
                      </p>
                    ) : null}

                    {uploadEncrypt && !whitelists.length ? (
                      <p className="feedback-error">
                        Create a whitelist before uploading an encrypted file.
                      </p>
                    ) : null}

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
              ) : null}

              {workspaceSection === "shared" ? (
                <section className="card workspace-panel">
                  <div className="card-header">
                    <h2>Open Shared File</h2>
                  </div>
                  <div className="upload-form">
                    <div className="form-field">
                      <label className="field-label" htmlFor="shared-blob-id">
                        Blob ID
                      </label>
                      <input
                        id="shared-blob-id"
                        className="text-input mono"
                        placeholder="Walrus blob ID"
                        value={sharedBlobIdInput}
                        onChange={(event) =>
                          setSharedBlobIdInput(event.target.value)
                        }
                      />
                    </div>
                    <div className="form-field">
                      <label className="field-label" htmlFor="shared-key-id">
                        Key ID
                      </label>
                      <input
                        id="shared-key-id"
                        className="text-input mono"
                        placeholder="0x..."
                        value={sharedKeyIdInput}
                        onChange={(event) =>
                          setSharedKeyIdInput(event.target.value)
                        }
                      />
                    </div>
                    <div className="form-field">
                      <label className="field-label" htmlFor="shared-file-name">
                        File name
                      </label>
                      <input
                        id="shared-file-name"
                        className="text-input"
                        placeholder="Optional"
                        value={sharedFileNameInput}
                        onChange={(event) =>
                          setSharedFileNameInput(event.target.value)
                        }
                      />
                    </div>

                    <button
                      className="btn btn-black"
                      disabled={
                        downloadingObjectId === "shared-access" ||
                        !sharedBlobIdInput.trim() ||
                        !sharedKeyIdInput.trim() ||
                        !isSealConfigured
                      }
                      onClick={() => void handleSharedAccessDownload()}
                      type="button"
                    >
                      {downloadingObjectId === "shared-access"
                        ? "Decrypting\u2026"
                        : "Decrypt & download"}
                    </button>

                    {sharedAccessError ? (
                      <p className="feedback-error">{sharedAccessError}</p>
                    ) : null}

                    <p className="hint-text">
                      Paste the blob ID and key ID that the owner shared with
                      you. Seal will check the Sui whitelist before releasing
                      the key.
                    </p>
                  </div>
                </section>
              ) : null}

              {workspaceSection === "assets" ? (
                <section className="card workspace-panel">
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
                      <p className="state-text">
                        No assets on {currentNetwork}.
                      </p>
                    )
                  ) : null}
                </section>
              ) : null}

              {workspaceSection === "files" ? (
                <section className="card files-panel workspace-panel">
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

                  {filesTab === "active" &&
                  !walrusFilesQuery.isPending &&
                  !walrusFilesQuery.isError ? (
                    activeFiles.length > 0 ? (
                      <div className="file-list">
                        {activeFiles.map((file) => {
                          const localMetadata = getStoredLocalMetadata(
                            file.objectId,
                          );
                          const linkedWhitelist = getStoredWhitelist(
                            localMetadata?.whitelistId ?? null,
                          );
                          const isSealed = Boolean(localMetadata?.keyId);

                          return (
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
                                      uploaded{" "}
                                      {formatUploadedAt(file.uploadedAt)}
                                    </span>
                                  ) : null}
                                  {isSealed ? (
                                    <span className="badge-mode badge-seal">
                                      seal allowlist
                                    </span>
                                  ) : null}
                                  {linkedWhitelist ? (
                                    <span className="meta-chip">
                                      list {linkedWhitelist.name}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              <div className="file-row-actions">
                                {file.deletable ? (
                                  <button
                                    className="btn btn-danger btn-sm"
                                    disabled={
                                      deletingObjectId === file.objectId
                                    }
                                    onClick={() => void handleDelete(file)}
                                    title="Delete blob"
                                    type="button"
                                  >
                                    {deletingObjectId === file.objectId
                                      ? "…"
                                      : "Delete"}
                                  </button>
                                ) : null}
                                {localMetadata?.keyId ? (
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() =>
                                      void handleCopy(
                                        `access-${file.objectId}`,
                                        createAccessPayload(
                                          file,
                                          localMetadata,
                                        ),
                                      )
                                    }
                                    type="button"
                                  >
                                    {copiedKey === `access-${file.objectId}`
                                      ? "Copied"
                                      : "Link"}
                                  </button>
                                ) : null}
                                <button
                                  className="btn btn-outline btn-sm"
                                  onClick={() =>
                                    void (localMetadata?.keyId
                                      ? handleEncryptedDownload(
                                          file,
                                          localMetadata,
                                        )
                                      : handleDownload(
                                          file.downloadUrl,
                                          file.fileName !==
                                            `blob-${file.blobId.slice(0, 10)}`
                                            ? file.fileName
                                            : file.objectId,
                                          file.contentType,
                                          file.objectId,
                                        ))
                                  }
                                  type="button"
                                >
                                  {downloadingObjectId === file.objectId
                                    ? "…"
                                    : "↓"}
                                </button>
                              </div>
                              {fileActionFeedback[file.objectId] ? (
                                <p className="feedback-error">
                                  {fileActionFeedback[file.objectId]?.message}
                                </p>
                              ) : null}
                            </article>
                          );
                        })}
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
                                    {copiedKey ===
                                    `deleted-object-${file.objectId}`
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
                                      {copiedKey ===
                                      `deleted-blob-${file.objectId}`
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
              ) : null}
            </div>
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

function formatDeletedTimestamp(timestampMs: string): string {
  const value = Number(timestampMs);

  if (!Number.isFinite(value)) {
    return "recently";
  }

  return new Date(value).toLocaleString();
}

function getTransactionDigest(result: {
  $kind: "Transaction" | "FailedTransaction";
  FailedTransaction?: { digest: string };
  Transaction?: { digest: string };
}) {
  return result.$kind === "Transaction"
    ? (result.Transaction?.digest ?? "")
    : (result.FailedTransaction?.digest ?? "");
}

function extractWhitelistCreation(
  transactionBlock: {
    objectChanges?: Array<{
      objectId?: string;
      objectType?: string;
      type: string;
    }> | null;
  },
  packageId: string,
) {
  const objectChanges = transactionBlock.objectChanges ?? [];
  const whitelistId = objectChanges.find(
    (change) =>
      change.type === "created" &&
      change.objectType ===
        `${packageId}::${SEAL_POLICY_MODULE_NAME}::Whitelist`,
  )?.objectId;
  const capId = objectChanges.find(
    (change) =>
      change.type === "created" &&
      change.objectType === `${packageId}::${SEAL_POLICY_MODULE_NAME}::Cap`,
  )?.objectId;

  if (!whitelistId || !capId) {
    throw new Error(
      "Could not resolve the new whitelist objects from the transaction response.",
    );
  }

  return {
    capId,
    whitelistId,
  };
}

function createKeyIdForWhitelist(whitelistId: string) {
  const prefixBytes = hexStringToBytes(normalizeSuiAddress(whitelistId));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const bytes = new Uint8Array(prefixBytes.length + nonce.length);

  bytes.set(prefixBytes, 0);
  bytes.set(nonce, prefixBytes.length);

  return bytesToHex(bytes);
}

function deriveWhitelistIdFromKeyId(keyId: string) {
  const bytes = hexStringToBytes(keyId);

  if (bytes.length < 32) {
    throw new Error("Key ID is too short to contain a whitelist object ID.");
  }

  return normalizeSuiAddress(bytesToHex(bytes.slice(0, 32)));
}

function doesKeyIdMatchWhitelist(keyId: string, whitelistId: string) {
  try {
    return (
      deriveWhitelistIdFromKeyId(keyId) === normalizeSuiAddress(whitelistId)
    );
  } catch {
    return false;
  }
}

function bytesToHex(bytes: Uint8Array) {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function resolveDownloadMimeType(
  arrayBuffer: ArrayBuffer,
  contentType: string | null,
  responseContentType?: string | null,
) {
  const headerMime = contentType ?? responseContentType ?? null;

  return !headerMime || headerMime === "application/octet-stream"
    ? (sniffMimeType(arrayBuffer) ?? headerMime ?? "application/octet-stream")
    : headerMime;
}

function triggerFileDownload(
  data: BlobPart,
  fileName: string,
  mimeType: string,
) {
  const blob = new Blob([data], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = ensureExtension(fileName, mimeType);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}

function createAccessPayload(
  file: WalrusBlobRecord,
  metadata: LocalWalrusFileMetadata,
) {
  return JSON.stringify({
    blobId: file.blobId,
    fileName: metadata.fileName ?? file.fileName,
    keyId: metadata.keyId,
  });
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
