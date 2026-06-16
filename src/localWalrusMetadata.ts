import { type WalrusBlobRecord } from "./walrus";

export type LocalWalrusFileMetadata = {
  blobId: string;
  contentType: string | null;
  encrypted: boolean;
  fileName: string | null;
  folderPath: string | null;
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
  isMyselfGroup: boolean;
  members: string[];
  name: string;
  ownerAddress: string;
  packageId: string | null;
};

export type LocalFolderAccessPolicy = {
  folderPath: string;
  updatedAt: string;
  whitelistId: string;
  whitelistName: string;
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
  folders: string[];
  folderPolicies: LocalFolderAccessPolicy[];
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
    folders: ["/"],
    folderPolicies: [],
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
      folders: normalizeLocalFolderPaths(parsed.folders),
      folderPolicies: Array.isArray(parsed.folderPolicies)
        ? parsed.folderPolicies.map(normalizeLocalFolderAccessPolicy)
        : [],
      whitelists: Array.isArray(parsed.whitelists)
        ? parsed.whitelists.map(normalizeLocalWalrusWhitelist)
        : [],
    };
  } catch {
    return getEmptyState();
  }
}

function normalizeLocalFolderPaths(folders: unknown): string[] {
  const normalized = new Set<string>(["/"]);

  if (Array.isArray(folders)) {
    for (const folder of folders) {
      if (typeof folder === "string") {
        normalized.add(normalizeFolderPath(folder));
      }
    }
  }

  return Array.from(normalized).sort((left, right) =>
    left.localeCompare(right),
  );
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
    folderPath:
      typeof metadata.folderPath === "string" ? metadata.folderPath : null,
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

function normalizeLocalFolderAccessPolicy(
  policy: Partial<LocalFolderAccessPolicy>,
): LocalFolderAccessPolicy {
  return {
    folderPath:
      typeof policy.folderPath === "string" && policy.folderPath
        ? normalizeFolderPath(policy.folderPath)
        : "/",
    updatedAt:
      typeof policy.updatedAt === "string"
        ? policy.updatedAt
        : new Date().toISOString(),
    whitelistId: typeof policy.whitelistId === "string" ? policy.whitelistId : "",
    whitelistName:
      typeof policy.whitelistName === "string"
        ? policy.whitelistName
        : "Untitled list",
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
    isMyselfGroup: whitelist.isMyselfGroup === true,
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

function normalizeFolderPath(path: string) {
  const trimmed = path.trim();

  if (!trimmed || trimmed === "/") {
    return "/";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
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
      | "folderPath"
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
    folders: current.folders,
    folderPolicies: current.folderPolicies,
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
    folders: current.folders,
    folderPolicies: current.folderPolicies,
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
    folders: current.folders,
    folderPolicies: current.folderPolicies,
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
    folders: current.folders,
    folderPolicies: current.folderPolicies,
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
    folders: current.folders,
    folderPolicies: current.folderPolicies,
    whitelists: current.whitelists,
  });

  return deletedRecord;
}

export function listLocalFolderAccessPolicies(network: string, address: string) {
  return readState(network, address).folderPolicies.sort((left, right) =>
    left.folderPath.localeCompare(right.folderPath),
  );
}

export function listLocalFolders(network: string, address: string) {
  return normalizeLocalFolderPaths(readState(network, address).folders);
}

export function saveLocalFolder(
  network: string,
  address: string,
  folderPath: string,
) {
  const current = readState(network, address);
  const normalizedPath = normalizeFolderPath(folderPath);

  writeState(network, address, {
    active: current.active,
    deleted: current.deleted,
    folders: normalizeLocalFolderPaths([...current.folders, normalizedPath]),
    folderPolicies: current.folderPolicies,
    whitelists: current.whitelists,
  });

  return normalizedPath;
}

export function saveLocalFolderAccessPolicy(
  network: string,
  address: string,
  policy: LocalFolderAccessPolicy,
) {
  const current = readState(network, address);
  const normalized = normalizeLocalFolderAccessPolicy(policy);

  writeState(network, address, {
    active: current.active,
    deleted: current.deleted,
    folders: current.folders,
    folderPolicies: [
      normalized,
      ...current.folderPolicies.filter(
        (item) => item.folderPath !== normalized.folderPath,
      ),
    ],
    whitelists: current.whitelists,
  });
}

export function deleteLocalFolderAccessPolicy(
  network: string,
  address: string,
  folderPath: string,
) {
  const current = readState(network, address);
  const normalizedPath = normalizeFolderPath(folderPath);

  writeState(network, address, {
    active: current.active,
    deleted: current.deleted,
    folders: current.folders,
    folderPolicies: current.folderPolicies.filter(
      (item) => item.folderPath !== normalizedPath,
    ),
    whitelists: current.whitelists,
  });
}
