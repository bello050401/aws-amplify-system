/**
 * ImageProcessingPanel 実React境界試験(2026-09-13)専用エントリ。
 * 本物のapp/inventory/ImageProcessingPanel.tsx(再実装・模倣ではない)を
 * react-dom/clientでブラウザへ実際にmountする——Server Action境界
 * (@/app/actions/imageProcessing)とuseInventoryImageUrlだけをesbuildの
 * aliasでモックに差し替える(build.mjs参照)。実AWS/Next.js不要。
 */
import { createRoot } from "react-dom/client";
import * as React from "react";
import { ImageProcessingPanel } from "@/app/inventory/ImageProcessingPanel";

interface PanelProps {
  inventoryId: string;
  images: { storageKey: string; originalHash: string | null }[];
}

declare global {
  interface Window {
    __initialProps: PanelProps;
    __setPanelProps: (props: PanelProps) => void;
  }
}

function Harness() {
  const [props, setProps] = React.useState<PanelProps>(window.__initialProps);
  React.useEffect(() => {
    window.__setPanelProps = setProps;
  }, []);
  return <ImageProcessingPanel inventoryId={props.inventoryId} images={props.images} />;
}

const container = document.getElementById("root");
if (!container) throw new Error("harness: #root not found");
createRoot(container).render(<Harness />);
