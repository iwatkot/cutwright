import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale } from './core';
export function useLocale() { return useSyncExternalStore(subscribeLocale, getLocale, () => 'en' as const); }
