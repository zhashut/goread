export async function pickPdfPaths(multiple: boolean = true): Promise<string[]> {
  const [{ open }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
  ] as any);
  const selected: any = await open({
    multiple,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  const paths: string[] = Array.isArray(selected)
    ? selected.map((s: any) => (typeof s === "string" ? s : s?.path))
    : selected
    ? [typeof selected === "string" ? selected : selected?.path]
    : [];
  return paths.filter(Boolean);
}

export function pathToTitle(filePath: string): string {
  const name = filePath.split("\\").pop()?.split("/").pop() || "";
  return name.replace(/\.pdf$/i, "");
}

export async function waitNextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}