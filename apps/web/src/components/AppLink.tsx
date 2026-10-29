import type { ComponentChildren } from 'preact';
import { navigate } from '../lib/router';

interface AppLinkProps {
  readonly href: string;
  readonly children: ComponentChildren;
  readonly class?: string;
  /** Return false to cancel navigation (for example "leave while captioning?"). */
  readonly confirmLeave?: () => boolean;
}

/** In-app link: a real anchor (so it works with keyboards, middle-click and screen readers) that navigates without a reload. */
export function AppLink({ href, children, class: className, confirmLeave }: AppLinkProps) {
  return (
    <a
      href={href}
      class={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (confirmLeave && !confirmLeave()) return;
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
