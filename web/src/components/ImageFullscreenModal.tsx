// SPDX-License-Identifier: AGPL-3.0-only
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";

interface ImageFullscreenModalProps {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Fullscreen image modal with pinch-to-zoom support.
 * Uses react-zoom-pan-pinch for smooth gestures on mobile.
 */
export function ImageFullscreenModal({
  src,
  alt,
  open,
  onOpenChange,
}: ImageFullscreenModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center"
          aria-describedby={undefined}
        >
          {/* Hidden title for accessibility */}
          <DialogPrimitive.Title className="sr-only">
            {alt || "Image preview"}
          </DialogPrimitive.Title>

          {/* Close button - fixed position top right, respects iOS safe area */}
          <DialogPrimitive.Close
            className="absolute right-4 z-50 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition-colors min-w-[var(--control-touch)] min-h-[var(--control-touch)] flex items-center justify-center"
            style={{ top: "max(1rem, env(safe-area-inset-top, 1rem))" }}
            aria-label="Close"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </DialogPrimitive.Close>

          {/* Pinch-to-zoom wrapper */}
          <TransformWrapper
            initialScale={1}
            minScale={1}
            maxScale={5}
            centerOnInit={true}
            wheel={{ step: 0.1 }}
            pinch={{ step: 5 }}
            doubleClick={{ disabled: true }}
            panning={{ disabled: false }}
          >
            <TransformComponent
              wrapperStyle={{
                width: "100%",
                height: "100%",
              }}
              contentStyle={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <img
                src={src}
                alt={alt}
                className="max-h-[100vh] max-w-[100vw] object-contain select-none"
                draggable={false}
              />
            </TransformComponent>
          </TransformWrapper>

          {/* Hint text at bottom */}
          <div className="absolute bottom-4 left-0 right-0 text-center text-white/60 text-sm pointer-events-none">
            Pinch to zoom
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
