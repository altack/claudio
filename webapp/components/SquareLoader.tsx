// Inline morphing square — the standard "we're working" indicator. Reuses
// the same 6–8px solid-square language as StatusDot, but cycles through
// accent/ok/warn/err and squashes/rotates so it reads as motion at a glance.
//
// Layout: keeps a fixed 14×14 box so siblings don't reflow; the inner span
// scales/rotates within it via transform.

export function SquareLoader({
  className,
  title,
}: {
  className?: string;
  title?: string;
}) {
  return (
    <span
      role={title ? "status" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={`square-loader${className ? ` ${className}` : ""}`}
      title={title}
    >
      <span className="square-loader__inner" />
    </span>
  );
}
