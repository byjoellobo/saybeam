import { useEffect, useState } from 'preact/hooks';
import { normalizeRoomCode } from '@saybeam/protocol';

export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'speak'; readonly code: string }
  | { readonly name: 'listen'; readonly code: string }
  | { readonly name: 'fix'; readonly code: string }
  | { readonly name: 'bench' }
  | { readonly name: 'about' }
  | { readonly name: 'not-found' };

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // malformed %-escapes must not crash the app
  }
};

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  const [head, arg] = parts;
  if (!head) return { name: 'home' };
  if (parts.length === 1 && head === 'bench') return { name: 'bench' };
  if (parts.length === 1 && head === 'about') return { name: 'about' };
  if (parts.length === 2 && arg) {
    const code = normalizeRoomCode(safeDecode(arg));
    if (!code) return { name: 'not-found' };
    if (head === 'speak') return { name: 'speak', code };
    if (head === 'r') return { name: 'listen', code };
    if (head === 'fix') return { name: 'fix', code };
  }
  // A bare code typed into the address bar: example.org/ABC123
  if (parts.length === 1) {
    const code = normalizeRoomCode(safeDecode(head));
    if (code) return { name: 'listen', code };
  }
  return { name: 'not-found' };
}

const ROUTE_EVENT = 'saybeam:navigate';

export function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new Event(ROUTE_EVENT));
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.pathname));
    window.addEventListener('popstate', update);
    window.addEventListener(ROUTE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(ROUTE_EVENT, update);
    };
  }, []);
  return route;
}

export const paths = {
  speak: (code: string) => `/speak/${code}`,
  listen: (code: string) => `/r/${code}`,
  fix: (code: string, token: string) => `/fix/${code}#${token}`,
};
