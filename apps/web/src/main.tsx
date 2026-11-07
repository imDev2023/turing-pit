import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import "@fontsource-variable/big-shoulders-display";
import "@fontsource-variable/instrument-sans";
import "./styles.css";
import { App } from "./App";
import { RPC_URL } from "./config";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      {/* Wallets that support the Wallet Standard (Phantom, Solflare, Backpack...) appear automatically. */}
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </React.StrictMode>,
);
