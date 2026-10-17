import { useSyncExternalStore } from 'react';

const query = '(max-width: 900px)';
const subscribe = (change: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
};
/** View state only: changing screen size never changes the project. */
export const useCompactLayout = () => useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
