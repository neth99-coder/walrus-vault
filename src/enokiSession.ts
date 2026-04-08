import { createStore, get } from "idb-keyval";
import {
  getSession as getEnokiWalletSession,
  isEnokiWallet,
  type EnokiNetwork,
} from "@mysten/enoki";

const ENOKI_IDB_STORE_NAME = "enoki";
const ENOKI_NATIVE_SIGNER_KEY = "ephemeralKeyPair";
const ENOKI_NETWORKS: EnokiNetwork[] = ["mainnet", "testnet", "devnet"];

type EnokiSessionSnapshot = {
  nativeSigner: unknown | null;
  network: EnokiNetwork;
  session: Awaited<ReturnType<typeof getEnokiWalletSession>>;
};

export async function clearEnokiIndexedDb(options: { network?: string } = {}) {
  const config = getEnokiConfig();

  if (!config) {
    console.log("[enoki] clear-indexeddb:skip:no-config", {
      network: options.network ?? null,
    });
    return;
  }

  const networks = options.network
    ? [toEnokiNetwork(options.network)]
    : ENOKI_NETWORKS;

  console.log("[enoki] clear-indexeddb:start", {
    networks,
    stateDb: getEnokiStateDatabaseName(config),
    sessionDbs: networks.map((network) =>
      getEnokiSessionDatabaseName(config, network),
    ),
  });

  await Promise.all([
    deleteDatabase(getEnokiStateDatabaseName(config)),
    ...networks.map((network) =>
      deleteDatabase(getEnokiSessionDatabaseName(config, network)),
    ),
  ]);

  console.log("[enoki] clear-indexeddb:done", { networks });
}

export async function clearInvalidEnokiLoginState(options: {
  network?: string;
  wallet?: unknown;
}) {
  const snapshot = await getEnokiSessionSnapshot(options);

  console.log("[enoki] clear-invalid-login-state:check", {
    hasSnapshot: Boolean(snapshot),
    hasSession: Boolean(snapshot?.session),
    hasNativeSigner: Boolean(snapshot?.nativeSigner),
    network: snapshot?.network ?? options.network ?? null,
    sessionExpiresAt: snapshot?.session?.expiresAt ?? null,
  });

  if (!snapshot?.session) {
    return false;
  }

  if (snapshot.session.expiresAt <= Date.now()) {
    console.log("[enoki] clear-invalid-login-state:expired", {
      network: snapshot.network,
      sessionExpiresAt: snapshot.session.expiresAt,
    });
    await clearEnokiIndexedDb({ network: snapshot.network });
    return true;
  }

  return false;
}

export async function ensureEnokiIndexedDbReady(options: {
  clearInvalid?: boolean;
  context: string;
  network?: string;
  requireNativeSigner?: boolean;
  requireSession?: boolean;
  wallet?: unknown;
}) {
  console.log("[enoki] ensure-indexeddb-ready:start", {
    clearInvalid: options.clearInvalid ?? true,
    context: options.context,
    network: options.network ?? null,
    requireNativeSigner: options.requireNativeSigner ?? false,
    requireSession: options.requireSession ?? true,
  });

  const snapshot = await getEnokiSessionSnapshot(options);

  if (!snapshot) {
    console.log("[enoki] ensure-indexeddb-ready:skip:not-enoki-wallet", {
      context: options.context,
    });
    return null;
  }

  console.log("[enoki] ensure-indexeddb-ready:snapshot", {
    context: options.context,
    hasNativeSigner: Boolean(snapshot.nativeSigner),
    hasSession: Boolean(snapshot.session),
    network: snapshot.network,
    sessionExpiresAt: snapshot.session?.expiresAt ?? null,
    sessionHasJwt: Boolean(snapshot.session?.jwt),
    sessionHasProof: Boolean(snapshot.session?.proof),
  });

  if (!snapshot.session) {
    if (options.requireSession === false) {
      return snapshot;
    }

    throw new Error(
      `No Enoki session is available for ${options.context}. Sign in again.`,
    );
  }

  if (snapshot.session.expiresAt <= Date.now()) {
    if (options.clearInvalid !== false) {
      await clearEnokiIndexedDb({ network: snapshot.network });
    }

    throw new Error(
      `Your Enoki session has expired for ${options.context}. Sign in again.`,
    );
  }

  if (options.requireNativeSigner && !snapshot.nativeSigner) {
    if (options.clearInvalid !== false) {
      await clearEnokiIndexedDb({ network: snapshot.network });
    }

    throw new Error(
      `Your Enoki IndexedDB data is incomplete for ${options.context}. Sign in again.`,
    );
  }

  console.log("[enoki] ensure-indexeddb-ready:ok", {
    context: options.context,
    hasNativeSigner: Boolean(snapshot.nativeSigner),
    network: snapshot.network,
  });

  return snapshot;
}

export async function getEnokiSessionSnapshot(options: {
  network?: string;
  wallet?: unknown;
}): Promise<EnokiSessionSnapshot | null> {
  const { wallet } = options;

  if (
    !wallet ||
    !isEnokiWallet(wallet as Parameters<typeof isEnokiWallet>[0])
  ) {
    console.log("[enoki] session-snapshot:skip:not-enoki-wallet", {
      network: options.network ?? null,
    });
    return null;
  }

  const config = getEnokiConfig();

  if (!config) {
    console.log("[enoki] session-snapshot:skip:no-config", {
      network: options.network ?? null,
    });
    return null;
  }

  const network = toEnokiNetwork(options.network);
  const stateDb = getEnokiStateDatabaseName(config);
  const sessionDb = getEnokiSessionDatabaseName(config, network);

  console.log("[enoki] session-snapshot:start", {
    network,
    stateDb,
    sessionDb,
  });

  const session = await getEnokiWalletSession(
    wallet as Parameters<typeof getEnokiWalletSession>[0],
    { network },
  );
  const nativeSigner = await getStoredEnokiNativeSigner({
    clientId: config.clientId,
    network,
  });

  return {
    nativeSigner,
    network,
    session,
  };
}

export function toEnokiNetwork(network?: string): EnokiNetwork {
  switch (network) {
    case "mainnet":
    case "testnet":
    case "devnet":
      return network;
    default:
      return "testnet";
  }
}

async function deleteDatabase(name: string) {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name);

    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function getEnokiConfig() {
  const apiKey = import.meta.env.VITE_ENOKI_API_KEY as string | undefined;
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

  if (!apiKey || !clientId) {
    return null;
  }

  return { apiKey, clientId };
}

function getEnokiSessionDatabaseName(
  config: { apiKey: string; clientId: string },
  network: EnokiNetwork,
) {
  return `${config.apiKey}_${network}_${config.clientId}`;
}

function getEnokiStateDatabaseName(config: {
  apiKey: string;
  clientId: string;
}) {
  return `${config.apiKey}_${config.clientId}`;
}

async function getStoredEnokiNativeSigner(options: {
  clientId: string;
  network: EnokiNetwork;
}) {
  const config = getEnokiConfig();

  if (!config) {
    console.log("[enoki] native-signer:skip:no-config", {
      network: options.network,
    });
    return null;
  }

  const sessionDb = getEnokiSessionDatabaseName(
    { apiKey: config.apiKey, clientId: options.clientId },
    options.network,
  );

  const idbStore = createStore(sessionDb, ENOKI_IDB_STORE_NAME);

  const nativeSigner = (await get(ENOKI_NATIVE_SIGNER_KEY, idbStore)) ?? null;

  console.log("[enoki] native-signer:loaded", {
    hasNativeSigner: Boolean(nativeSigner),
    network: options.network,
    sessionDb,
    storeName: ENOKI_IDB_STORE_NAME,
  });

  return nativeSigner;
}
