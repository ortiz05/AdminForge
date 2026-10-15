import type { ReactNode } from 'react';
import { Button, type ButtonProps } from './Button';
import { Tooltip } from './Tooltip';

export type IconButtonProps = Omit<ButtonProps, 'children' | 'size'> & {
  /** Accessible name, also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md';
  /** Tooltip side; `false` hides the tooltip (the label is visible elsewhere). */
  tooltip?: 'top' | 'right' | 'bottom' | 'left' | false;
};

export function IconButton({
  label,
  icon,
  size = 'md',
  intent = 'ghost',
  tooltip = 'top',
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip
      content={rest.locked ? `${label}. ${rest.locked}` : label}
      side={tooltip || undefined}
      disabled={tooltip === false}
    >
      <Button {...rest} intent={intent} size={size === 'sm' ? 'icon-sm' : 'icon'} aria-label={label}>
        {icon}
      </Button>
    </Tooltip>
  );
}
