/**
 * Grist-backed replacement for the old localStorage metadata store
 * (formerly src/localWalrusMetadata.ts). Same exported types and function
 * names/shapes as before — the only difference callers need to handle is
 * that every function here is async (network-backed) instead of sync.
 *
 * Calls go through the data-room-server backend (see gristClient.ts), which
 * proxies to the Grist REST API. The Grist API key lives only in the
 * backend's env — it is never sent to the browser — and the backend also
 * sets CORS headers so the browser can reach it directly.
 *
 * Every table is scoped by an (OwnerAddress, Network) pair carried as plain
 * Grist columns (there's no per-wallet partition like localStorage's key),
 * matching the "myWallet"/"ownerAddress" fields the original types already
 * used where present.
 */

import {
  deleteGristRecords,
  listGristRecords,
  upsertGristRecords,
} from "./gristClient";
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

export type LocalSharedFolderRecord = {
  myWallet: string;
  sharedFolder: string;
  teamId: string;
  teamName: string;
  teamOwner: string;
  updatedAt: string;
};

export type LocalSharedWalrusFileMetadata = {
  blobId: string;
  contentType: string | null;
  fileName: string | null;
  folderPath: string | null;
  keyId: string | null;
  myWallet: string;
  objectId: string;
  packageId: string | null;
  sharedFolder: string;
  teamId: string;
  teamName: string;
  teamOwner: string;
  uploadedAt: string | null;
  whitelistId: string | null;
  whitelistName: string | null;
};

function normalizeWalletAddress(value: string) {
  return value.trim().toLowerCase();
}

function normalizeFolderPath(path: string) {
  const trimmed = path.trim();

  if (!trimmed || trimmed === "/") {
    return "/";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

async function deleteMatchingRecords(
  table: string,
  filter: Record<string, Array<string | number | boolean>>,
) {
  const records = await listGristRecords(table, filter);
  await deleteGristRecords(
    table,
    records.map((record) => record.id),
  );
}

// ---------------------------------------------------------------------------
// Files (active)
// ---------------------------------------------------------------------------

type FilesFields = {
  OwnerAddress: string;
  Network: string;
  ObjectId: string;
  BlobId: string;
  ContentType: string | null;
  Encrypted: boolean;
  FileName: string | null;
  FolderPath: string | null;
  KeyId: string | null;
  PackageId: string | null;
  UploadedAt: string | null;
  WhitelistCapId: string | null;
  WhitelistId: string | null;
  WhitelistName: string | null;
};

function toLocalWalrusFileMetadata(fields: FilesFields): LocalWalrusFileMetadata {
  return {
    blobId: fields.BlobId ?? "",
    contentType: fields.ContentType ?? null,
    encrypted: Boolean(fields.Encrypted),
    fileName: fields.FileName ?? null,
    folderPath: fields.FolderPath ?? null,
    keyId: fields.KeyId ?? null,
    objectId: fields.ObjectId ?? "",
    packageId: fields.PackageId ?? null,
    uploadedAt: fields.UploadedAt ?? null,
    whitelistCapId: fields.WhitelistCapId ?? null,
    whitelistId: fields.WhitelistId ?? null,
    whitelistName: fields.WhitelistName ?? null,
  };
}

export async function listLocalWalrusFileMetadata(
  network: string,
  address: string,
): Promise<LocalWalrusFileMetadata[]> {
  const records = await listGristRecords<FilesFields>("Files", {
    OwnerAddress: [normalizeWalletAddress(address)],
    Network: [network],
  });

  return records.map((record) => toLocalWalrusFileMetadata(record.fields));
}

export async function saveLocalWalrusFile(
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
): Promise<void> {
  const ownerAddress = normalizeWalletAddress(address);

  await upsertGristRecords<FilesFields>("Files", [
    {
      require: { OwnerAddress: ownerAddress, Network: network, ObjectId: record.objectId },
      fields: {
        OwnerAddress: ownerAddress,
        Network: network,
        ObjectId: record.objectId,
        BlobId: record.blobId,
        ContentType: record.contentType ?? null,
        Encrypted: options?.encrypted ?? false,
        FileName: record.fileName ?? null,
        FolderPath: options?.folderPath ?? null,
        KeyId: options?.keyId ?? null,
        PackageId: options?.packageId ?? null,
        UploadedAt: record.uploadedAt ?? null,
        WhitelistCapId: options?.whitelistCapId ?? null,
        WhitelistId: options?.whitelistId ?? null,
        WhitelistName: options?.whitelistName ?? null,
      },
    },
  ]);

  await deleteMatchingRecords("DeletedFiles", {
    OwnerAddress: [ownerAddress],
    Network: [network],
    ObjectId: [record.objectId],
  });
}

export async function patchLocalWalrusFileMetadata(
  network: string,
  address: string,
  objectId: string,
  patch: Partial<LocalWalrusFileMetadata>,
): Promise<LocalWalrusFileMetadata | null> {
  const ownerAddress = normalizeWalletAddress(address);
  const existing = await listGristRecords<FilesFields>("Files", {
    OwnerAddress: [ownerAddress],
    Network: [network],
    ObjectId: [objectId],
  });

  if (existing.length === 0) {
    return null;
  }

  const merged = toLocalWalrusFileMetadata({ ...existing[0].fields, ...patch } as FilesFields);

  await upsertGristRecords<FilesFields>("Files", [
    {
      require: { OwnerAddress: ownerAddress, Network: network, ObjectId: objectId },
      fields: {
        OwnerAddress: ownerAddress,
        Network: network,
        ObjectId: merged.objectId,
        BlobId: merged.blobId,
        ContentType: merged.contentType,
        Encrypted: merged.encrypted,
        FileName: merged.fileName,
        FolderPath: merged.folderPath,
        KeyId: merged.keyId,
        PackageId: merged.packageId,
        UploadedAt: merged.uploadedAt,
        WhitelistCapId: merged.whitelistCapId,
        WhitelistId: merged.whitelistId,
        WhitelistName: merged.whitelistName,
      },
    },
  ]);

  return merged;
}

// ---------------------------------------------------------------------------
// Deleted files (history)
// ---------------------------------------------------------------------------

type DeletedFilesFields = {
  OwnerAddress: string;
  Network: string;
  ObjectId: string;
  BlobId: string | null;
  ContentType: string | null;
  Deletable: boolean | null;
  Digest: string | null;
  FileName: string | null;
  Size: string | null;
  StoredUntilEpoch: number | null;
  TimestampMs: string | null;
  UploadedAt: string | null;
};

export async function listLocalDeletedWalrusFiles(
  network: string,
  address: string,
): Promise<DeletedBlobRecord[]> {
  const records = await listGristRecords<DeletedFilesFields>("DeletedFiles", {
    OwnerAddress: [normalizeWalletAddress(address)],
    Network: [network],
  });

  return records
    .map(
      (record): DeletedBlobRecord => ({
        blobId: record.fields.BlobId ?? null,
        contentType: record.fields.ContentType ?? null,
        deletable: record.fields.Deletable ?? null,
        digest: record.fields.Digest ?? null,
        fileName: record.fields.FileName ?? null,
        objectId: record.fields.ObjectId ?? "",
        size: record.fields.Size ?? null,
        storedUntilEpoch: record.fields.StoredUntilEpoch ?? null,
        timestampMs: record.fields.TimestampMs ?? null,
        uploadedAt: record.fields.UploadedAt ?? null,
      }),
    )
    .sort(
      (left, right) =>
        Number(right.timestampMs ?? 0) - Number(left.timestampMs ?? 0),
    );
}

export async function markLocalWalrusFileDeleted(
  network: string,
  address: string,
  file: WalrusBlobRecord,
): Promise<DeletedBlobRecord> {
  const ownerAddress = normalizeWalletAddress(address);
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

  await upsertGristRecords<DeletedFilesFields>("DeletedFiles", [
    {
      require: { OwnerAddress: ownerAddress, Network: network, ObjectId: file.objectId },
      fields: {
        OwnerAddress: ownerAddress,
        Network: network,
        ObjectId: deletedRecord.objectId,
        BlobId: deletedRecord.blobId,
        ContentType: deletedRecord.contentType,
        Deletable: deletedRecord.deletable,
        Digest: deletedRecord.digest,
        FileName: deletedRecord.fileName,
        Size: deletedRecord.size,
        StoredUntilEpoch: deletedRecord.storedUntilEpoch,
        TimestampMs: deletedRecord.timestampMs,
        UploadedAt: deletedRecord.uploadedAt,
      },
    },
  ]);

  await deleteMatchingRecords("Files", {
    OwnerAddress: [ownerAddress],
    Network: [network],
    ObjectId: [file.objectId],
  });

  return deletedRecord;
}

// ---------------------------------------------------------------------------
// Whitelists
// ---------------------------------------------------------------------------

type WhitelistsFields = {
  OwnerAddress: string;
  Network: string;
  WhitelistId: string;
  CapId: string;
  Name: string;
  IsMyselfGroup: boolean;
  Members: string;
  PackageId: string | null;
  CreatedAt: string;
};

function toLocalWalrusWhitelist(fields: WhitelistsFields): LocalWalrusWhitelist {
  let members: string[] = [];
  try {
    const parsed: unknown = JSON.parse(fields.Members || "[]");
    if (Array.isArray(parsed)) {
      members = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    members = [];
  }

  return {
    capId: fields.CapId ?? "",
    createdAt: fields.CreatedAt ?? new Date().toISOString(),
    id: fields.WhitelistId ?? "",
    isMyselfGroup: Boolean(fields.IsMyselfGroup),
    members,
    name: fields.Name || "Untitled list",
    ownerAddress: fields.OwnerAddress ?? "",
    packageId: fields.PackageId ?? null,
  };
}

export async function listLocalWalrusWhitelists(
  network: string,
  address: string,
): Promise<LocalWalrusWhitelist[]> {
  const records = await listGristRecords<WhitelistsFields>("Whitelists", {
    OwnerAddress: [normalizeWalletAddress(address)],
    Network: [network],
  });

  return records
    .map((record) => toLocalWalrusWhitelist(record.fields))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function saveLocalWalrusWhitelist(
  network: string,
  address: string,
  whitelist: LocalWalrusWhitelist,
): Promise<void> {
  const ownerAddress = normalizeWalletAddress(address);

  await upsertGristRecords<WhitelistsFields>("Whitelists", [
    {
      require: { OwnerAddress: ownerAddress, Network: network, WhitelistId: whitelist.id },
      fields: {
        OwnerAddress: ownerAddress,
        Network: network,
        WhitelistId: whitelist.id,
        CapId: whitelist.capId,
        Name: whitelist.name,
        IsMyselfGroup: whitelist.isMyselfGroup,
        Members: JSON.stringify(whitelist.members),
        PackageId: whitelist.packageId,
        CreatedAt: whitelist.createdAt,
      },
    },
  ]);
}

export async function patchLocalWalrusWhitelist(
  network: string,
  address: string,
  whitelistId: string,
  patch: Partial<LocalWalrusWhitelist>,
): Promise<LocalWalrusWhitelist | null> {
  const ownerAddress = normalizeWalletAddress(address);
  const existing = await listGristRecords<WhitelistsFields>("Whitelists", {
    OwnerAddress: [ownerAddress],
    Network: [network],
    WhitelistId: [whitelistId],
  });

  if (existing.length === 0) {
    return null;
  }

  const current = toLocalWalrusWhitelist(existing[0].fields);
  const merged = { ...current, ...patch };

  await saveLocalWalrusWhitelist(network, address, merged);

  return merged;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

type FoldersFields = {
  OwnerAddress: string;
  Network: string;
  FolderPath: string;
};

export async function listLocalFolders(
  network: string,
  address: string,
): Promise<string[]> {
  const records = await listGristRecords<FoldersFields>("Folders", {
    OwnerAddress: [normalizeWalletAddress(address)],
    Network: [network],
  });

  const folders = new Set<string>(["/"]);
  for (const record of records) {
    if (record.fields.FolderPath) {
      folders.add(normalizeFolderPath(record.fields.FolderPath));
    }
  }

  return Array.from(folders).sort((left, right) => left.localeCompare(right));
}

export async function saveLocalFolder(
  network: string,
  address: string,
  folderPath: string,
): Promise<string> {
  const ownerAddress = normalizeWalletAddress(address);
  const normalizedPath = normalizeFolderPath(folderPath);

  await upsertGristRecords<FoldersFields>("Folders", [
    {
      require: { OwnerAddress: ownerAddress, Network: network, FolderPath: normalizedPath },
      fields: { OwnerAddress: ownerAddress, Network: network, FolderPath: normalizedPath },
    },
  ]);

  return normalizedPath;
}

// ---------------------------------------------------------------------------
// Folder access policies
// ---------------------------------------------------------------------------

type FolderAccessPoliciesFields = {
  OwnerAddress: string;
  Network: string;
  FolderPath: string;
  WhitelistId: string;
  WhitelistName: string;
  UpdatedAt: string;
};

export async function listLocalFolderAccessPolicies(
  network: string,
  address: string,
): Promise<LocalFolderAccessPolicy[]> {
  const records = await listGristRecords<FolderAccessPoliciesFields>(
    "FolderAccessPolicies",
    { OwnerAddress: [normalizeWalletAddress(address)], Network: [network] },
  );

  return records
    .map(
      (record): LocalFolderAccessPolicy => ({
        folderPath: normalizeFolderPath(record.fields.FolderPath || "/"),
        updatedAt: record.fields.UpdatedAt || new Date().toISOString(),
        whitelistId: record.fields.WhitelistId ?? "",
        whitelistName: record.fields.WhitelistName || "Untitled list",
      }),
    )
    .sort((left, right) => left.folderPath.localeCompare(right.folderPath));
}

export async function saveLocalFolderAccessPolicy(
  network: string,
  address: string,
  policy: LocalFolderAccessPolicy,
): Promise<void> {
  const ownerAddress = normalizeWalletAddress(address);
  const normalizedPath = normalizeFolderPath(policy.folderPath);

  await upsertGristRecords<FolderAccessPoliciesFields>("FolderAccessPolicies", [
    {
      require: { OwnerAddress: ownerAddress, Network: network, FolderPath: normalizedPath },
      fields: {
        OwnerAddress: ownerAddress,
        Network: network,
        FolderPath: normalizedPath,
        WhitelistId: policy.whitelistId,
        WhitelistName: policy.whitelistName,
        UpdatedAt: policy.updatedAt,
      },
    },
  ]);
}

export async function deleteLocalFolderAccessPolicy(
  network: string,
  address: string,
  folderPath: string,
): Promise<void> {
  await deleteMatchingRecords("FolderAccessPolicies", {
    OwnerAddress: [normalizeWalletAddress(address)],
    Network: [network],
    FolderPath: [normalizeFolderPath(folderPath)],
  });
}

// ---------------------------------------------------------------------------
// Shared folders (folders shared with `myWallet` by a team owner)
// ---------------------------------------------------------------------------

type SharedFoldersFields = {
  MyWallet: string;
  Network: string;
  TeamId: string;
  TeamName: string;
  TeamOwner: string;
  SharedFolder: string;
  UpdatedAt: string;
};

export async function listLocalSharedFolders(
  network: string,
  address: string,
): Promise<LocalSharedFolderRecord[]> {
  const normalizedAddress = normalizeWalletAddress(address);
  const records = await listGristRecords<SharedFoldersFields>("SharedFolders", {
    MyWallet: [normalizedAddress],
    Network: [network],
  });

  return records
    .map(
      (record): LocalSharedFolderRecord => ({
        myWallet: normalizedAddress,
        sharedFolder: normalizeFolderPath(record.fields.SharedFolder || "/"),
        teamId: record.fields.TeamId ?? "",
        teamName: record.fields.TeamName || "Untitled team",
        teamOwner: normalizeWalletAddress(record.fields.TeamOwner ?? ""),
        updatedAt: record.fields.UpdatedAt || new Date().toISOString(),
      }),
    )
    .sort(
      (left, right) =>
        Number(new Date(right.updatedAt)) - Number(new Date(left.updatedAt)),
    );
}

export async function saveLocalSharedFolder(
  network: string,
  address: string,
  record: LocalSharedFolderRecord,
): Promise<void> {
  const myWallet = normalizeWalletAddress(address);
  const teamOwner = normalizeWalletAddress(record.teamOwner);
  const sharedFolder = normalizeFolderPath(record.sharedFolder);

  await upsertGristRecords<SharedFoldersFields>("SharedFolders", [
    {
      require: {
        MyWallet: myWallet,
        Network: network,
        TeamId: record.teamId,
        TeamOwner: teamOwner,
        SharedFolder: sharedFolder,
      },
      fields: {
        MyWallet: myWallet,
        Network: network,
        TeamId: record.teamId,
        TeamName: record.teamName,
        TeamOwner: teamOwner,
        SharedFolder: sharedFolder,
        UpdatedAt: record.updatedAt,
      },
    },
  ]);
}

export async function removeLocalSharedFolder(
  network: string,
  address: string,
  options: { sharedFolder?: string; teamId: string; teamOwner: string },
): Promise<void> {
  const filter: Record<string, Array<string | number | boolean>> = {
    MyWallet: [normalizeWalletAddress(address)],
    Network: [network],
    TeamId: [options.teamId],
    TeamOwner: [normalizeWalletAddress(options.teamOwner)],
  };

  if (options.sharedFolder !== undefined) {
    filter.SharedFolder = [normalizeFolderPath(options.sharedFolder)];
  }

  await deleteMatchingRecords("SharedFolders", filter);
}

// ---------------------------------------------------------------------------
// Shared files (files within a shared folder)
// ---------------------------------------------------------------------------

type SharedFilesFields = {
  MyWallet: string;
  Network: string;
  TeamId: string;
  TeamName: string;
  TeamOwner: string;
  SharedFolder: string;
  ObjectId: string;
  BlobId: string;
  ContentType: string | null;
  FileName: string | null;
  FolderPath: string | null;
  KeyId: string | null;
  PackageId: string | null;
  UploadedAt: string | null;
  WhitelistId: string | null;
  WhitelistName: string | null;
};

function toLocalSharedWalrusFileMetadata(
  fields: SharedFilesFields,
): LocalSharedWalrusFileMetadata {
  return {
    blobId: fields.BlobId ?? "",
    contentType: fields.ContentType ?? null,
    fileName: fields.FileName ?? null,
    folderPath: fields.FolderPath ?? null,
    keyId: fields.KeyId ?? null,
    myWallet: normalizeWalletAddress(fields.MyWallet ?? ""),
    objectId: fields.ObjectId ?? "",
    packageId: fields.PackageId ?? null,
    sharedFolder: normalizeFolderPath(fields.SharedFolder || "/"),
    teamId: fields.TeamId ?? "",
    teamName: fields.TeamName || "Untitled team",
    teamOwner: normalizeWalletAddress(fields.TeamOwner ?? ""),
    uploadedAt: fields.UploadedAt ?? null,
    whitelistId: fields.WhitelistId ?? null,
    whitelistName: fields.WhitelistName ?? null,
  };
}

export async function listLocalSharedWalrusFiles(
  network: string,
  address: string,
): Promise<LocalSharedWalrusFileMetadata[]> {
  const records = await listGristRecords<SharedFilesFields>("SharedFiles", {
    MyWallet: [normalizeWalletAddress(address)],
    Network: [network],
  });

  return records
    .map((record) => toLocalSharedWalrusFileMetadata(record.fields))
    .sort((left, right) =>
      (left.fileName ?? left.objectId).localeCompare(
        right.fileName ?? right.objectId,
      ),
    );
}

export async function saveLocalSharedWalrusFile(
  network: string,
  address: string,
  file: LocalSharedWalrusFileMetadata,
): Promise<void> {
  const myWallet = normalizeWalletAddress(address);
  const teamOwner = normalizeWalletAddress(file.teamOwner);
  const sharedFolder = normalizeFolderPath(file.sharedFolder);

  await upsertGristRecords<SharedFilesFields>("SharedFiles", [
    {
      require: {
        MyWallet: myWallet,
        Network: network,
        TeamId: file.teamId,
        TeamOwner: teamOwner,
        SharedFolder: sharedFolder,
        ObjectId: file.objectId,
      },
      fields: {
        MyWallet: myWallet,
        Network: network,
        TeamId: file.teamId,
        TeamName: file.teamName,
        TeamOwner: teamOwner,
        SharedFolder: sharedFolder,
        ObjectId: file.objectId,
        BlobId: file.blobId,
        ContentType: file.contentType,
        FileName: file.fileName,
        FolderPath: file.folderPath,
        KeyId: file.keyId,
        PackageId: file.packageId,
        UploadedAt: file.uploadedAt,
        WhitelistId: file.whitelistId,
        WhitelistName: file.whitelistName,
      },
    },
  ]);
}

export async function removeLocalSharedWalrusFiles(
  network: string,
  address: string,
  options: { sharedFolder?: string; teamId: string; teamOwner: string },
): Promise<void> {
  const filter: Record<string, Array<string | number | boolean>> = {
    MyWallet: [normalizeWalletAddress(address)],
    Network: [network],
    TeamId: [options.teamId],
    TeamOwner: [normalizeWalletAddress(options.teamOwner)],
  };

  if (options.sharedFolder !== undefined) {
    filter.SharedFolder = [normalizeFolderPath(options.sharedFolder)];
  }

  await deleteMatchingRecords("SharedFiles", filter);
}

export async function removeLocalSharedWalrusFile(
  network: string,
  address: string,
  options: { objectId: string; teamId: string; teamOwner: string },
): Promise<void> {
  await deleteMatchingRecords("SharedFiles", {
    MyWallet: [normalizeWalletAddress(address)],
    Network: [network],
    TeamId: [options.teamId],
    TeamOwner: [normalizeWalletAddress(options.teamOwner)],
    ObjectId: [options.objectId],
  });
}

// ---------------------------------------------------------------------------
// Seen shared folders / files — tracks which shared items (by id) this
// wallet has already opened, so the UI can point out exactly what's new
// since the last visit instead of a generic "you have shares" notice.
// ---------------------------------------------------------------------------

type SeenIdsFields = {
  MyWallet: string;
  Network: string;
  Kind: "sharedFolder" | "sharedFile";
  ItemId: string;
};

async function listSeenIds(
  kind: SeenIdsFields["Kind"],
  network: string,
  address: string,
): Promise<string[]> {
  const records = await listGristRecords<SeenIdsFields>("SeenIds", {
    MyWallet: [normalizeWalletAddress(address)],
    Network: [network],
    Kind: [kind],
  });

  return records.map((record) => record.fields.ItemId);
}

async function markSeenIds(
  kind: SeenIdsFields["Kind"],
  network: string,
  address: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const myWallet = normalizeWalletAddress(address);

  await upsertGristRecords<SeenIdsFields>(
    "SeenIds",
    ids.map((id) => ({
      require: { MyWallet: myWallet, Network: network, Kind: kind, ItemId: id },
      fields: { MyWallet: myWallet, Network: network, Kind: kind, ItemId: id },
    })),
  );
}

// Shared-folder ids are `${teamOwner}:${folderPath}` (see `sharedFolderItems`
// in App.tsx).
export function listSeenSharedFolderIds(network: string, address: string) {
  return listSeenIds("sharedFolder", network, address);
}

export function markSharedFolderIdsSeen(
  network: string,
  address: string,
  ids: string[],
) {
  return markSeenIds("sharedFolder", network, address, ids);
}

// Shared-file ids are Walrus blob object ids.
export function listSeenSharedFileIds(network: string, address: string) {
  return listSeenIds("sharedFile", network, address);
}

export function markSharedFileIdsSeen(
  network: string,
  address: string,
  ids: string[],
) {
  return markSeenIds("sharedFile", network, address, ids);
}
