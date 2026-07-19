// Object-URL lifecycle for a repository Blob: create when the blobId is set, revoke on
// unmount or when the blobId changes. CSP allows blob: URLs. StrictMode double-mount is
// safe — the cleanup revokes the first URL before the second effect creates a fresh one.

import { useEffect, useState } from "react";

import type { SessionRepository } from "../core/session";

export function useBlobUrl(
  repo: SessionRepository,
  blobId: string | undefined,
): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!blobId) {
      setUrl(undefined);
      return;
    }
    let revoked = false;
    let objectUrl: string | undefined;
    void repo.getBlob(blobId).then((blob) => {
      if (revoked || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(undefined);
    };
  }, [repo, blobId]);

  return url;
}
