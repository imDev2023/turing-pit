import { PublicKey } from "@solana/web3.js";

// Set at build time by CI from the house keys (public addresses only).
export const RPC_URL = import.meta.env.VITE_RPC_URL || "https://api.devnet.solana.com";
export const PROGRAM_ID = import.meta.env.VITE_PROGRAM_ID ? new PublicKey(import.meta.env.VITE_PROGRAM_ID) : null;
export const AUTHORITY = import.meta.env.VITE_AUTHORITY ? new PublicKey(import.meta.env.VITE_AUTHORITY) : null;

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
