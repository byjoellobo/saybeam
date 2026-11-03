/**
 * Saybeam's own line icons: 24-unit grid, 2px round strokes, drawn in the
 * current text colour. Always decorative: the control next to them names the action.
 */
const PATHS = {
  users: 'M13.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0M3.5 20v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1M16 4.7a3.5 3.5 0 0 1 0 6.6M19 14.6a5 5 0 0 1 2 4.4v1',
  expand: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  chevron: 'M6 9l6 6 6-6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  readonly name: IconName;
  readonly class?: string;
}

export function Icon({ name, class: extra }: IconProps) {
  return (
    <svg
      class={extra ? `icon ${extra}` : 'icon'}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
