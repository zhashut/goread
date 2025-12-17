import { useCallback, useMemo } from "react";

interface UseSelectAllParams {
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  candidates: string[];
}

export const useSelectAll = ({
  selected,
  setSelected,
  candidates,
}: UseSelectAllParams) => {
  const canSelectAll = useMemo(() => candidates.length > 0, [candidates]);

  const allSelected = useMemo(
    () => canSelectAll && candidates.every((p) => selected.includes(p)),
    [canSelectAll, candidates, selected]
  );

  const toggleSelectAll = useCallback(() => {
    if (!canSelectAll) return;
    setSelected((prev) => {
      const allSelectedNow =
        candidates.length > 0 && candidates.every((p) => prev.includes(p));
      if (allSelectedNow) {
        return prev.filter((p) => !candidates.includes(p));
      }
      return Array.from(new Set([...prev, ...candidates]));
    });
  }, [setSelected, candidates, canSelectAll]);

  const strokeColor = canSelectAll ? (allSelected ? "#d23c3c" : "#333") : "#bbb";

  return {
    canSelectAll,
    allSelected,
    strokeColor,
    toggleSelectAll,
  };
};

