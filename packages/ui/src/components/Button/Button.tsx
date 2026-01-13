import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconPosition?: 'left' | 'right';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      icon,
      iconPosition = 'left',
      disabled,
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    const classes = [
      'vuhlp-btn',
      `vuhlp-btn--${variant}`,
      `vuhlp-btn--${size}`,
      loading && 'vuhlp-btn--loading',
      icon && !children && 'vuhlp-btn--icon-only',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        className={classes}
        disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <span className="vuhlp-btn__spinner" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none">
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray="28"
                strokeDashoffset="8"
              />
            </svg>
          </span>
        )}
        {icon && iconPosition === 'left' && !loading && (
          <span className="vuhlp-btn__icon">{icon}</span>
        )}
        {children && <span className="vuhlp-btn__label">{children}</span>}
        {icon && iconPosition === 'right' && (
          <span className="vuhlp-btn__icon">{icon}</span>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
