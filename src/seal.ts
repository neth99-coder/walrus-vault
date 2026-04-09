import { CurrentAccountSigner, type DAppKit } from "@mysten/dapp-kit-core";
import {
  SealClient,
  SessionKey,
  type KeyServerConfig,
  type SealCompatibleClient,
} from "@mysten/seal";
import {
  Transaction,
  type TransactionArgument,
} from "@mysten/sui/transactions";

export const DEFAULT_TESTNET_SEAL_SERVER_CONFIGS: KeyServerConfig[] = [
  {
    objectId:
      "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
    aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com",
    weight: 1,
  },
];

type SealClientOptions = {
  serverConfigs?: KeyServerConfig[];
  timeout?: number;
  verifyKeyServers?: boolean;
};

type EncryptWithSealArgs = SealClientOptions & {
  aad?: Uint8Array;
  data: Uint8Array;
  id: string;
  packageId: string;
  suiClient: SealCompatibleClient;
  threshold?: number;
};

type CreateSessionKeyArgs = {
  address: string;
  dAppKit: DAppKit<any, any>;
  mvrName?: string;
  packageId: string;
  suiClient: SealCompatibleClient;
  ttlMin?: number;
};

type DecryptWithSealArgs = SealClientOptions & {
  address?: string;
  checkLEEncoding?: boolean;
  checkShareConsistency?: boolean;
  dAppKit?: DAppKit<any, any>;
  encryptedBytes: Uint8Array;
  mvrName?: string;
  packageId?: string;
  sessionKey?: SessionKey;
  suiClient: SealCompatibleClient;
  ttlMin?: number;
  txBytes: Uint8Array;
};

type CreateApprovalTransactionArgs = {
  additionalArguments?: (tx: Transaction) => TransactionArgument[];
  functionName?: string;
  idBytes: Uint8Array;
  moduleName: string;
  packageId: string;
};

export function createSealClient(
  suiClient: SealCompatibleClient,
  options: SealClientOptions = {},
) {
  return new SealClient({
    serverConfigs: options.serverConfigs ?? DEFAULT_TESTNET_SEAL_SERVER_CONFIGS,
    suiClient,
    timeout: options.timeout,
    verifyKeyServers: options.verifyKeyServers ?? false,
  });
}

export async function encryptWithSeal({
  aad,
  data,
  id,
  packageId,
  serverConfigs,
  suiClient,
  threshold = 1,
  timeout,
  verifyKeyServers,
}: EncryptWithSealArgs) {
  const sealClient = createSealClient(suiClient, {
    serverConfigs,
    timeout,
    verifyKeyServers,
  });

  console.log("[seal] encrypt:start", {
    aadBytes: aad?.byteLength ?? 0,
    dataBytes: data.byteLength,
    id,
    packageId,
    threshold,
  });

  const encrypted = await sealClient.encrypt({
    aad,
    data,
    id,
    packageId,
    threshold,
  });

  console.log("[seal] encrypt:done", {
    encryptedBytes: encrypted.encryptedObject.byteLength,
    keyBytes: encrypted.key.byteLength,
    keyHexPrefix: Array.from(encrypted.key.slice(0, 8))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(""),
  });

  return encrypted;
}

export async function createWalletBackedSessionKey({
  address,
  dAppKit,
  mvrName,
  packageId,
  suiClient,
  ttlMin = 10,
}: CreateSessionKeyArgs) {
  console.log("[seal] session:create:start", {
    address,
    mvrName: mvrName ?? null,
    packageId,
    ttlMin,
  });

  const signer = new CurrentAccountSigner(dAppKit);

  console.log("[seal] session:create:wallet-signer-ready", {
    address,
    packageId,
  });

  const sessionKey = await SessionKey.create({
    address,
    mvrName,
    packageId,
    signer,
    suiClient,
    ttlMin,
  });

  const personalMessage = sessionKey.getPersonalMessage();

  console.log("[seal] session:create:state", {
    address: sessionKey.getAddress(),
    isExpired: sessionKey.isExpired(),
    packageId: sessionKey.getPackageId(),
    packageName: sessionKey.getPackageName(),
    personalMessageBytes: personalMessage.byteLength,
    personalMessageText: decodeUtf8(personalMessage),
  });

  console.log(
    "[seal] session:create:export",
    summarizeExportedSessionKey(sessionKey.export()),
  );

  const certificate = await sessionKey.getCertificate();
  const exportedWithSignature = sessionKey.export();

  console.log(
    "[seal] session:create:export-with-signature",
    summarizeExportedSessionKey(exportedWithSignature),
  );

  await logLocalSignatureValidation({
    certificateSignature: certificate.signature,
    exportedSessionKey: exportedWithSignature,
    label: "[seal] session:create:local-signature-validation",
    suiClient,
  });

  console.log("[seal] session:create:certificate-ready", {
    address,
    certificate,
    packageId,
  });

  console.log("[seal] session:create:ready", { address, packageId });

  return sessionKey;
}

export function createSealApprovalTransaction({
  additionalArguments,
  functionName = "seal_approve",
  idBytes,
  moduleName,
  packageId,
}: CreateApprovalTransactionArgs) {
  const tx = new Transaction();

  tx.moveCall({
    target: `${packageId}::${moduleName}::${functionName}`,
    arguments: [
      tx.pure.vector("u8", Array.from(idBytes)),
      ...(additionalArguments?.(tx) ?? []),
    ],
  });

  return tx;
}

export async function buildTransactionKindBytes(
  suiClient: SealCompatibleClient,
  transaction: Transaction,
) {
  return transaction.build({ client: suiClient, onlyTransactionKind: true });
}

export async function decryptWithSeal({
  address,
  checkLEEncoding,
  checkShareConsistency,
  dAppKit,
  encryptedBytes,
  mvrName,
  packageId,
  serverConfigs,
  sessionKey,
  suiClient,
  timeout,
  ttlMin,
  txBytes,
  verifyKeyServers,
}: DecryptWithSealArgs) {
  const sealClient = createSealClient(suiClient, {
    serverConfigs,
    timeout,
    verifyKeyServers,
  });

  console.log("[seal] decrypt:start", {
    address: address ?? null,
    encryptedBytes: encryptedBytes.byteLength,
    hasSessionKey: Boolean(sessionKey),
    packageId: packageId ?? null,
    txBytes: txBytes.byteLength,
  });

  const resolvedSessionKey =
    sessionKey ??
    (await createWalletBackedSessionKey({
      address: requiredValue(address, "address"),
      dAppKit: requiredValue(dAppKit, "dAppKit"),
      mvrName,
      packageId: requiredValue(packageId, "packageId"),
      suiClient,
      ttlMin,
    }));

  const sessionState = summarizeSessionKey(resolvedSessionKey);

  console.log("[seal] decrypt:session-state", sessionState);

  const requestParams = await resolvedSessionKey.createRequestParams(txBytes);

  console.log("[seal] decrypt:request-params", {
    encKeyBytes: requestParams.encKey.byteLength,
    encKeyPkBytes: requestParams.encKeyPk.byteLength,
    encKeyPkPreview: toHexPreview(requestParams.encKeyPk),
    encVerificationKeyBytes: requestParams.encVerificationKey.byteLength,
    encVerificationKeyPreview: toHexPreview(requestParams.encVerificationKey),
    requestSignatureLength: requestParams.requestSignature.length,
    requestSignaturePrefix: requestParams.requestSignature.slice(0, 24),
  });

  const certificate = await resolvedSessionKey.getCertificate();
  const exportedWithSignature = resolvedSessionKey.export();

  console.log(
    "[seal] decrypt:export-with-signature",
    summarizeExportedSessionKey(exportedWithSignature),
  );

  await logLocalSignatureValidation({
    certificateSignature: certificate.signature,
    exportedSessionKey: exportedWithSignature,
    label: "[seal] decrypt:local-signature-validation",
    suiClient,
  });

  console.log("[seal] decrypt:certificate", {
    address: certificate.user,
    creationTime: certificate.creation_time,
    mvrName: certificate.mvr_name ?? null,
    packageId: resolvedSessionKey.getPackageId(),
    sessionVk: certificate.session_vk,
    signature: certificate.signature,
    ttlMin: certificate.ttl_min,
  });

  try {
    const decrypted = await sealClient.decrypt({
      checkLEEncoding,
      checkShareConsistency,
      data: encryptedBytes,
      sessionKey: resolvedSessionKey,
      txBytes,
    });

    console.log("[seal] decrypt:done", {
      decryptedBytes: decrypted.byteLength,
    });

    return decrypted;
  } catch (error) {
    console.log("[seal] decrypt:error", error);
    console.error("[seal] decrypt:error", {
      address: address ?? null,
      encryptedBytes: encryptedBytes.byteLength,
      sessionState,
      packageId: packageId ?? null,
      txBytes: txBytes.byteLength,
      error,
    });
    throw error;
  }
}

export function hexStringToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;

  if (normalized.length === 0) {
    return new Uint8Array();
  }

  if (normalized.length % 2 !== 0 || /[^\da-f]/i.test(normalized)) {
    throw new Error("Expected an even-length hex string.");
  }

  const bytes = new Uint8Array(normalized.length / 2);

  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }

  return bytes;
}

function requiredValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Missing required Seal option: ${name}`);
  }

  return value;
}

function summarizeSessionKey(sessionKey: SessionKey) {
  const exported = sessionKey.export();
  const personalMessage = sessionKey.getPersonalMessage();

  return {
    address: sessionKey.getAddress(),
    isExpired: sessionKey.isExpired(),
    packageId: sessionKey.getPackageId(),
    packageName: sessionKey.getPackageName(),
    personalMessageBytes: personalMessage.byteLength,
    personalMessageText: decodeUtf8(personalMessage),
    exported: summarizeExportedSessionKey(exported),
  };
}

function summarizeExportedSessionKey(
  exported: ReturnType<SessionKey["export"]>,
) {
  return {
    address: exported.address,
    creationTimeMs: exported.creationTimeMs,
    hasPersonalMessageSignature: Boolean(exported.personalMessageSignature),
    mvrName: exported.mvrName ?? null,
    packageId: exported.packageId,
    sessionKeyLength: exported.sessionKey.length,
    ttlMin: exported.ttlMin,
  };
}

function decodeUtf8(value: Uint8Array) {
  try {
    return new TextDecoder().decode(value);
  } catch {
    return null;
  }
}

function toHexPreview(value: Uint8Array, bytes = 8) {
  return Array.from(value.slice(0, bytes))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

async function logLocalSignatureValidation({
  certificateSignature,
  exportedSessionKey,
  label,
  suiClient,
}: {
  certificateSignature: string;
  exportedSessionKey: ReturnType<SessionKey["export"]>;
  label: string;
  suiClient: SealCompatibleClient;
}) {
  try {
    const sessionKeyForValidation = SessionKey.import(
      {
        ...exportedSessionKey,
        personalMessageSignature: undefined,
      },
      suiClient,
    );

    await sessionKeyForValidation.setPersonalMessageSignature(
      certificateSignature,
    );

    console.log(label, {
      ok: true,
      packageId: sessionKeyForValidation.getPackageId(),
      sessionAddress: sessionKeyForValidation.getAddress(),
      signatureLength: certificateSignature.length,
      signaturePrefix: certificateSignature.slice(0, 24),
    });
  } catch (error) {
    console.error(label, {
      ok: false,
      packageId: exportedSessionKey.packageId,
      sessionAddress: exportedSessionKey.address,
      signatureLength: certificateSignature.length,
      signaturePrefix: certificateSignature.slice(0, 24),
      error,
    });
  }
}
