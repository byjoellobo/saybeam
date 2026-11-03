import { SOURCE_URL } from '../lib/meta';
import { AppLink } from './AppLink';

/** Brand and site links, shared by the home, about, bench and message pages. */
export function SiteHeader() {
  return (
    <header class="site-head">
      <AppLink href="/" class="brand">
        <img src="/icons/icon.svg" alt="" width={36} height={36} />
        <span class="wordmark">Saybeam</span>
      </AppLink>
      <nav class="site-nav" aria-label="Site">
        <AppLink href="/about">About</AppLink>
        <a href={SOURCE_URL}>Source code</a>
      </nav>
    </header>
  );
}
