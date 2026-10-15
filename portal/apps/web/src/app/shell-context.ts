import { createContext, useContext } from 'react';
import type { ArmState } from './arm';

/** Shell-wide controls that live in one place but are triggered from several (palette, rail, pages). */
export interface ShellApi {
  arm: ArmState;
  openArmDialog: () => void;
  openPalette: () => void;
  extend: () => Promise<void>;
  disarm: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const api = useContext(ShellContext);
  if (!api) throw new Error('useShell() is only available inside the AppShell.');
  return api;
}
