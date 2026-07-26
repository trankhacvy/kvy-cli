"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

/**
 * The landing page's single motion primitive — a fade+rise either on mount
 * (`immediate`, above-the-fold hero elements) or on first scroll into view
 * (everything else). One element per animated block, transform/opacity only,
 * strong ease-out, and a hard `prefers-reduced-motion` collapse to static.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  immediate = false,
}: {
  children: ReactNode;
  className?: string;
  /** Seconds before the element's own transition starts (hero stagger). */
  delay?: number;
  /** Animate on mount instead of on scroll-into-view (hero only). */
  immediate?: boolean;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      {...(immediate
        ? { animate: { opacity: 1, y: 0 } }
        : { whileInView: { opacity: 1, y: 0 }, viewport: { once: true, amount: 0.25 } })}
      transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
