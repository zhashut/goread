export const RENDER_QUALITY_OPTIONS = [
  { label: "极速(Thumbnail)", value: "thumbnail" },
  { label: "标准(Standard)", value: "standard" },
  { label: "高清(High)", value: "high" },
  { label: "超清(Best)", value: "best" },
];

export const DEFAULT_RENDER_QUALITY = "standard";

export const QUALITY_SCALE_MAP: Record<string, number> = {
  thumbnail: 0.5,
  standard: 1.0,
  high: 1.5,
  best: 2.0,
};
