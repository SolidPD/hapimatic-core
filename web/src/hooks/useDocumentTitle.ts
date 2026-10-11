// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";

export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
