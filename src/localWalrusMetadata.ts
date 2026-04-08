import { type WalrusBlobRecord } from "./walrus";

export type LocalWalrusFileMetadata = {
  blobId: string;
  contentType: string | null;
  encrypted: boolean;
  fileName: string | null;
  keyId: string | null;
  objectId: string;
  packageId: string | null;
  uploadedAt: string | null;
  whitelistCapId: string | null;
  whitelistId: string | null;
  whitelistName: string | null;
};

export type LocalWalrusWhitelist = {
  capId: string;
  createdAt: string;
  id: string;
  members: string[];
  name: string;
  ownerAddress: string;
  packageId: string | null;
};

export type DeletedBlobRecord = {
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

type LocalWalrusMetadataState = {
  active: LocalWalrusFileMetadata[];
  deleted: DeletedBlobRecord[];
  whitelists: LocalWalrusWhitelist[];
};

const STORAGE_KEY_PREFIX = "walrus-local-metadata";

function createStorageKey(network: string, address: string) {
  return `${STORAGE_KEY_PREFIX}:${network}:${address.toLowerCase()}`;
}

function getEmptyState(): LocalWalrusMetadataState {
  return {
    active: [],
    deleted: [],
    whitelists: [],
  };
}

function canUseLocalStorage() {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  );
}

function readState(network: string, address: string): LocalWalrusMetadataState {
  if (!canUseLocalStorage()) {
    return getEmptyState();
  }

  try {
    const rawValue = window.localStorage.getItem(
      createStorageKey(network, address),
    );

    if (!rawValue) {
      return getEmptyState();
    }

    const parsed = JSON.parse(rawValue) as Partial<LocalWalrusMetadataState>;

    return {
      active: Array.isArray(parsed.active)
        ? parsed.active.map(normalizeLocalWalrusFileMetadata)
        : [],
      deleted: Array.isArray(parsed.deleted) ? parsed.deleted : [],
      whitelists: Array.isArray(parsed.whitelists)
        ? parsed.whitelists.map(normalizeLocalWalrusWhitelist)
        : [],
    };
  } catch {
    return getEmptyState();
  }
}

function normalizeLocalWalrusFileMetadata(
  metadata: Partial<LocalWalrusFileMetadata>,
): LocalWalrusFileMetadata {
  return {
    blobId: typeof metadata.blobId === "string" ? metadata.blobId : "",
    contentType:
      typeof metadata.contentType === "string" ? metadata.contentType : null,
    encrypted:
      typeof metadata.encrypted === "boolean" ? metadata.encrypted : false,
    fileName: typeof metadata.fileName === "string" ? metadata.fileName : null,
    keyId: typeof metadata.keyId === "string" ? metadata.keyId : null,
    objectId: typeof metadata.objectId === "string" ? metadata.objectId : "",
    packageId:
      typeof metadata.packageId === "string" ? metadata.packageId : null,
    uploadedAt:
      typeof metadata.uploadedAt === "string" ? metadata.uploadedAt : null,
    whitelistCapId:
      typeof metadata.whitelistCapId === "string"
        ? metadata.whitelistCapId
        : null,
    whitelistId:
      typeof metadata.whitelistId === "string" ? metadata.whitelistId : null,
    whitelistName:
      typeof metadata.whitelistName === "string"
        ? metadata.whitelistName
        : null,
  };
}

function normalizeLocalWalrusWhitelist(
  whitelist: Partial<LocalWalrusWhitelist>,
): LocalWalrusWhitelist {
  return {
    capId: typeof whitelist.capId === "string" ? whitelist.capId : "",
    createdAt:
      typeof whitelist.createdAt === "string"
        ? whitelist.createdAt
        : new Date().toISOString(),
    id: typeof whitelist.id === "string" ? whitelist.id : "",
    members: Array.isArray(whitelist.members)
      ? whitelist.members.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    name: typeof whitelist.name === "string" ? whitelist.name : "Untitled list",
    ownerAddress:
      typeof whitelist.ownerAddress === "string" ? whitelist.ownerAddress : "",
    packageId:
      typeof whitelist.packageId === "string" ? whitelist.packageId : null,
  };
}

function writeState(
  network: string,
  address: string,
  state: LocalWalrusMetadataState,
) {
  if (!canUseLocalStorage()) {
    return;
  }

  window.localStorage.setItem(
    createStorageKey(network, address),
    JSON.stringify(state),
  );
}

export function listLocalWalrusFileMetadata(network: string, address: string) {
  return readState(network, address).active;
}

export function listLocalDeletedWalrusFiles(network: string, address: string) {
  return readState(network, address).deleted.sort(
    (left, right) =>
      Number(right.timestampMs ?? 0) - Number(left.timestampMs ?? 0),
  );
}

export function listLocalWalrusWhitelists(network: string, address: string) {
  return readState(network, address).whitelists.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function saveLocalWalrusFile(
  network: string,
  address: string,
  record: Pick<
    WalrusBlobRecord,
    "blobId" | "contentType" | "fileName" | "objectId" | "uploadedAt"
  >,
  options?: Partial<
    Pick<
      LocalWalrusFileMetadata,
      | "encrypted"
      | "keyId"
      | "packageId"
      | "whitelistCapId"
      | "whitelistId"
      | "whitelistName"
    >
  >,
) {
  const current = readState(network, address);
  const active = current.active.filter(
    (item) => item.objectId !== record.objectId,
  );
  const deleted = current.deleted.filter(
    (item) => item.objectId !== record.objectId,
  );

  active.push(
    normalizeLocalWalrusFileMetadata({
      ...record,
      ...options,
    }),
  );

  writeState(network, address, {
    active,
    deleted,
    whitelists: current.whitelists,
  });
}

export function patchLocalWalrusFileMetadata(
  network: string,
  address: string,
  objectId: string,
  patch: Partial<LocalWalrusFileMetadata>,
) {
  const current = readState(network, address);
  let hasMatch = false;

  const active = current.active.map((item) => {
    if (item.objectId !== objectId) {
      return item;
    }

    hasMatch = true;
    return normalizeLocalWalrusFileMetadata({
      ...item,
      ...patch,
    });
  });

  if (!hasMatch) {
    return null;
  }

  writeState(network, address, {
    active,
    deleted: current.deleted,
    whitelists: current.whitelists,
  });

  return active.find((item) => item.objectId === objectId) ?? null;
}

export function saveLocalWalrusWhitelist(
  network: string,
  address: string,
  whitelist: LocalWalrusWhitelist,
) {
  const current = readState(network, address);

  writeState(network, address, {
    active: current.active,
    deleted: current.deleted,
    whitelists: [
      normalizeLocalWalrusWhitelist(whitelist),
      ...current.whitelists.filter((item) => item.id !== whitelist.id),
    ],
  });
}

export function patchLocalWalrusWhitelist(
  network: string,
  address: string,
  whitelistId: string,
  patch: Partial<LocalWalrusWhitelist>,
) {
  const current = readState(network, address);
  let hasMatch = false;

  const whitelists = current.whitelists.map((item) => {
    if (item.id !== whitelistId) {
      return item;
    }

    hasMatch = true;

    return normalizeLocalWalrusWhitelist({
      ...item,
      ...patch,
    });
  });

  if (!hasMatch) {
    return null;
  }

  writeState(network, address, {
    active: current.active,
    deleted: current.deleted,
    whitelists,
  });

  return whitelists.find((item) => item.id === whitelistId) ?? null;
}

export function markLocalWalrusFileDeleted(
  network: string,
  address: string,
  file: WalrusBlobRecord,
): DeletedBlobRecord {
  const current = readState(network, address);
  const deletedRecord: DeletedBlobRecord = {
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
  };

  writeState(network, address, {
    active: current.active.filter((item) => item.objectId !== file.objectId),
    deleted: [
      deletedRecord,
      ...current.deleted.filter((item) => item.objectId !== file.objectId),
    ],
    whitelists: current.whitelists,
  });

  return deletedRecord;
}
