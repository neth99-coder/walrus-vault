import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

type BalanceRow = {
  balance: string;
  coinType: string;
  decimals: number;
  name: string;
  symbol: string;
};

const isConfigured = Boolean(
  import.meta.env.VITE_ENOKI_API_KEY && import.meta.env.VITE_GOOGLE_CLIENT_ID,
);

function App() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const currentNetwork = useCurrentNetwork();
  const wallet = useCurrentWallet();
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

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

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Sui Wallet</p>
          <h1>zkLogin</h1>
        </div>
        <div className="topbar-meta">
          <span className="meta-chip">{currentNetwork}</span>
          <span className="meta-chip">Google</span>
        </div>
      </header>

      {!isConfigured ? (
        <section className="panel warning-panel">
          <h2>Missing environment variables</h2>
          <p>
            Add <code>VITE_ENOKI_API_KEY</code> and{" "}
            <code>VITE_GOOGLE_CLIENT_ID</code> in
            <code>.env</code>.
          </p>
        </section>
      ) : null}

      <main className="content-grid">
        <section className="panel account-panel">
          <div className="panel-heading">
            <div>
              <p className="section-label">Account</p>
              <h2>{account ? "Connected" : "Sign in"}</h2>
            </div>
            <span className={`status-pill ${account ? "live" : "idle"}`}>
              {account ? "Connected" : "Waiting"}
            </span>
          </div>

          {account ? (
            <>
              <dl className="detail-list">
                <div>
                  <dt>Wallet</dt>
                  <dd>{wallet?.name ?? "Google zkLogin"}</dd>
                </div>
                <div>
                  <dt>Address</dt>
                  <dd className="mono break">{account.address}</dd>
                </div>
                <div>
                  <dt>Logout</dt>
                  <dd>Disconnect current session</dd>
                </div>
              </dl>

              <div className="actions">
                <button
                  className="primary-button"
                  onClick={() => void balancesQuery.refetch()}
                >
                  Refresh balances
                </button>
                <button
                  className="secondary-button"
                  onClick={() => void handleLogout()}
                >
                  Log out
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="actions">
                <button
                  className="google-button"
                  disabled={!googleWallet || !isConfigured || isSigningIn}
                  onClick={() => void handleGoogleLogin()}
                >
                  <span className="google-mark" aria-hidden="true">
                    G
                  </span>
                  {isSigningIn ? "Signing in..." : "Log in with Google"}
                </button>
              </div>

              {!googleWallet && isConfigured ? (
                <p className="helper-text">
                  Registering the Google wallet provider...
                </p>
              ) : null}

              {loginError ? (
                <p className="helper-text error-state">{loginError}</p>
              ) : null}
            </>
          )}
        </section>

        <section className="panel balances-panel">
          <div className="panel-heading">
            <div>
              <p className="section-label">Balances</p>
              <h2>Assets</h2>
            </div>
          </div>

          {!account ? (
            <p className="empty-state">Sign in to view balances.</p>
          ) : null}

          {balancesQuery.isPending ? (
            <p className="empty-state">Loading balances...</p>
          ) : null}

          {balancesQuery.isError ? (
            <p className="empty-state error-state">
              Failed to load balances. {(balancesQuery.error as Error).message}
            </p>
          ) : null}

          {account && !balancesQuery.isPending && !balancesQuery.isError ? (
            balancesQuery.data && balancesQuery.data.length > 0 ? (
              <div className="balance-list">
                {balancesQuery.data.map((balance) => (
                  <article className="balance-card" key={balance.coinType}>
                    <div>
                      <p className="token-symbol">{balance.symbol}</p>
                      <h3>{balance.name}</h3>
                      <p className="token-type mono break">
                        {balance.coinType}
                      </p>
                    </div>
                    <strong className="token-amount">
                      {formatBalance(balance.balance, balance.decimals)}
                    </strong>
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty-state">
                No balances found on {currentNetwork}.
              </p>
            )
          ) : null}
        </section>
      </main>
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

export default App;
