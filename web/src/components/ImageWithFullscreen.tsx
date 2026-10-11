// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { ImageFullscreenModal } from "./ImageFullscreenModal";

interface ImageWithFullscreenProps {
  src: string;
  alt: string;
  className?: string;
}

/**
 * Image component that opens a fullscreen modal with pinch-to-zoom when tapped.
 * Use this to wrap inline images that should be viewable at full resolution.
 */
export function ImageWithFullscreen({
  src,
  alt,
  className,
}: ImageWithFullscreenProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent parent dialogs from capturing the click
    e.preventDefault();
    setIsFullscreen(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.stopPropagation();
      e.preventDefault();
      setIsFullscreen(true);
    }
  };

  return (
    <>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        className={`cursor-pointer ${className ?? ""}`}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      />
      <ImageFullscreenModal
        src={src}
        alt={alt}
        open={isFullscreen}
        onOpenChange={setIsFullscreen}
      />
    </>
  );
}
