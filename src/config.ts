// Public Papertrade endpoints and HyperEVM contract addresses.

export const ORIGIN = process.env.PAPERTRADE_ORIGIN ?? "https://exchange.papertrade.xyz";
export const PUBLIC_RPC_URL = "https://rpc.hyperliquid.xyz/evm";
export const RPC_URL = process.env.PAPERTRADE_RPC ?? PUBLIC_RPC_URL;

export const EXCHANGE = "0x6cd5661646289fb6e65ea5c032310fded797d0a2" as const;
export const PAPER_STAKING = "0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016" as const;
