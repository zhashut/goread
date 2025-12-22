export type PageTransitionType = 'none' | 'fade';

export interface PageTransitionConfig {
  type: PageTransitionType;
  durationMs: number;
  timingFunction: string;
}

export const DEFAULT_PAGE_TRANSITION: PageTransitionConfig = {
  type: 'fade',
  durationMs: 220,
  timingFunction: 'cubic-bezier(0.4, 0.0, 0.2, 1)',
};

