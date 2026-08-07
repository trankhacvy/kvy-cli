"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

/**
 * The feature-row preview's motion wrapper: a slow levitation loop plus a
 * hover lift. Transform/opacity only, collapses to static under reduced
 * motion.
 */
export function PreviewFloat({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      animate={{ y: [0, -6, 0] }}
      transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
      whileHover={{ y: -3, scale: 1.015 }}
    >
      {children}
    </motion.div>
  );
}
