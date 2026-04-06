import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DAppKitProvider } from "@mysten/dapp-kit-react";

import App from "./App.tsx";
import { dAppKit } from "./dapp-kit.ts";
import { RegisterEnokiWallets } from "./RegisterEnokiWallets.tsx";
import "./index.css";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>
        <RegisterEnokiWallets />
        <App />
      </DAppKitProvider>
    </QueryClientProvider>
  </StrictMode>,
);
