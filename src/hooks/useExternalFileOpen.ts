import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { ExternalFileOpenPayload } from "../types";

interface ExternalFileEventDetail extends ExternalFileOpenPayload {
  path?: string;
}

export const useExternalFileOpen = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<ExternalFileEventDetail>;
      const detail = custom.detail;
      if (!detail || !detail.uri) return;

      const payload: ExternalFileEventDetail = {
        uri: detail.uri,
        mimeType: detail.mimeType,
        displayName: detail.displayName,
        fromNewIntent: detail.fromNewIntent,
        platform: detail.platform || "unknown",
        path: detail.path,
      };

      navigate("/reader/external", {
        state: {
          externalFile: payload,
        },
        replace: true,
      });
    };

    window.addEventListener(
      "goread:external-file-open",
      handler as EventListener,
    );
    return () => {
      window.removeEventListener(
        "goread:external-file-open",
        handler as EventListener,
      );
    };
  }, [navigate]);
};

